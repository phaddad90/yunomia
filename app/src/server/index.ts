import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { initLogger } from './logger.js';
import { loadLocalConfig, saveLocalConfig } from './local-config.js';
import { PrintPepperBoardClient, BoardError } from './board-client.js';
import { AuditPoller } from './audit-poller.js';
import { deriveAgentStates } from './agent-state.js';
import { AGENT_LIST, AGENTS_THAT_CAN_AUTH } from './types.js';
import { InboxStore, shouldNotifyCeo, summaryFor } from './inbox.js';
import type { InboxEntry, NormalizedEvent } from './inbox.js';
import { Notifier } from './notifier.js';
import { EventEmitter } from './events.js';
import { buildKickoffPrompt, ALLOWED_AGENT_CODES_FOR_KICKOFF, kickoffFilePath } from './kickoff.js';
import { buildDefaultGoals, ALLOWED_AGENT_CODES_FOR_GOALS, goalsFilePath } from './goals.js';
import { buildPrecompactPrompt, ALLOWED_AGENT_CODES_FOR_PRECOMPACT } from './precompact.js';
import { AgentsKbClient } from './agents-kb-client.js';
import { PresenceHeartbeat } from './presence-heartbeat.js';
import { PresencePoller } from './presence-poller.js';
import { ScheduleStore } from './schedule-store.js';
import { SchedulePoller } from './schedule-poller.js';
import type { AgentCode, AuditRow, MissionConfig, Ticket, WsMessage } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ───

function parseConfig(): MissionConfig {
  const args = process.argv.slice(2);
  let port = 4600;
  let agentCode: AgentCode = 'TA';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    if (args[i] === '--agent' && args[i + 1]) agentCode = args[++i] as AgentCode;
  }
  // Precedence: env > flag > persisted local config > default.
  if (process.env.PP_AGENT_CODE) agentCode = process.env.PP_AGENT_CODE as AgentCode;
  else {
    const stored = loadLocalConfig().agentCode;
    if (stored) agentCode = stored;
  }

  // Optional config file (next to the project root) for non-secret tweaks
  const configPath = join(process.cwd(), 'mission-control.config.json');
  let fileCfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { fileCfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* ignore */ }
  }

  const apiBase = (process.env.PP_API_BASE as string) || (fileCfg.apiBase as string) || 'https://admin.printpepper.co.uk';
  const agentToken = process.env.AGENT_API_TOKEN || (fileCfg.agentToken as string) || '';
  const webhookSecret = process.env.PP_WEBHOOK_SECRET || (fileCfg.webhookSecret as string | undefined);
  const auditPollMs = Number(process.env.PP_AUDIT_POLL_MS || fileCfg.auditPollMs || 8000);

  if (!agentToken) {
    console.error('Mission Control needs AGENT_API_TOKEN in env (or agentToken in mission-control.config.json).');
    process.exit(1);
  }

  return { port, apiBase, agentToken, agentCode, webhookSecret, auditPollMs };
}

// ─── Main ───

async function main() {
  const config = parseConfig();
  const logger = initLogger();

  logger.info({ port: config.port, apiBase: config.apiBase, agent: config.agentCode }, 'Mission Control starting');

  // Mutable identity ref — the v0.3 dropdown switcher updates this in place
  // without recreating the board client (so the audit poller, inbox, events
  // emitter, and webhook receiver all immediately use the new code).
  const identity = { current: config.agentCode };
  const board = new PrintPepperBoardClient(config.apiBase, config.agentToken, identity);
  const agentsKb = new AgentsKbClient(board, logger);
  const inbox = new InboxStore(undefined, logger);
  inbox.init();
  const schedules = new ScheduleStore(undefined, logger);
  schedules.init();
  const notifier = new Notifier(logger);
  // EventEmitter is bound to broadcast below; initialised after wss/clients
  // are set up so the closure can capture them.
  let events: EventEmitter | null = null;

  // Cache ticket lookups during a single tick to avoid hammering the API
  const ticketCache = new Map<string, { assignee_agent: AgentCode | null; audience: string; status: string; title: string }>();
  const fetchTicket = async (id: string) => {
    if (ticketCache.has(id)) return ticketCache.get(id)!;
    try {
      const r = await board.getTicket(id);
      const t = r.ticket;
      const lite = { assignee_agent: t.assignee_agent, audience: t.audience, status: t.status, title: t.title };
      ticketCache.set(id, lite);
      // expire after 30s — enough to coalesce a burst, short enough not to mask updates
      setTimeout(() => ticketCache.delete(id), 30_000);
      return lite;
    } catch {
      return null;
    }
  };

  /**
   * Run a board event through the CEO inbox filter. If relevant and new, append +
   * notify + broadcast. Used by both the audit poller and the webhook receiver.
   */
  async function processForInbox(evt: NormalizedEvent): Promise<void> {
    if (inbox.has(evt.delivery_id)) return;
    const verdict = await shouldNotifyCeo(evt, fetchTicket);
    if (!verdict.relevant) return;
    const summary = summaryFor(evt, verdict.ticket);
    const entry: InboxEntry = {
      delivery_id: evt.delivery_id,
      source: evt.source,
      event: evt.action,
      ticket_id: evt.ticket_id,
      ticket_human_id: evt.ticket_human_id,
      actor: evt.actor,
      ts: evt.ts,
      summary,
      processed: false,
    };
    if (inbox.append(entry)) {
      notifier.notify(summary);
      broadcast({ type: 'inbox_changed', data: { unprocessed: inbox.unprocessedCount() } });
      logger.info({ delivery_id: evt.delivery_id, action: evt.action, summary }, 'inbox event written');
    }
  }

  // ─── Express ───

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Static dashboard
  const dashboardDir = join(__dirname, '..', 'dashboard');
  const staticDir = existsSync(dashboardDir) ? dashboardDir : join(__dirname, '..', '..', 'src', 'dashboard');
  app.use(express.static(staticDir));

  // Identity (used by dashboard) — current value reads through the live ref.
  // Identity excludes PETER (Peter is a human assignee, not a callable agent).
  app.get('/api/me', (_req, res) => {
    res.json({
      agentCode: identity.current,
      apiBase: config.apiBase,
      allowed: AGENTS_THAT_CAN_AUTH,
    });
  });

  app.post('/api/me', (req, res) => {
    const next = req.body?.agentCode;
    if (typeof next !== 'string' || !AGENTS_THAT_CAN_AUTH.includes(next as AgentCode)) {
      return res.status(400).json({ error: 'agentCode must be one of ' + AGENTS_THAT_CAN_AUTH.join(', ') });
    }
    if (next === identity.current) return res.json({ agentCode: identity.current, changed: false });
    const prev = identity.current;
    identity.current = next as AgentCode;
    saveLocalConfig({ agentCode: identity.current });
    agentsKb.invalidate();
    logger.info({ prev, next: identity.current }, 'identity changed');
    broadcast({ type: 'identity_changed', data: { agentCode: identity.current, previous: prev } });
    res.json({ agentCode: identity.current, previous: prev, changed: true });
  });

  // ─── Board read-through (browser hits local server, server hits PrintPepper) ───

  app.get('/api/board/tickets', async (req, res) => {
    try {
      const tickets = await board.listTickets({
        status: req.query.status as string | undefined,
        assignee: req.query.assignee as string | undefined,
        audience: req.query.audience as 'app' | 'admin' | undefined,
        q: req.query.q as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 200,
      });
      const states = deriveAgentStates(tickets);
      res.json({ tickets, agents: states });
    } catch (err) {
      handleErr(res, err);
    }
  });

  app.get('/api/board/tickets/:id', async (req, res) => {
    try {
      // Single-ticket admin endpoint returns { ticket, audit } only; comments
      // live behind a separate route. Fetch both in parallel and merge so the
      // dashboard side panel can render the comm-layer in one round-trip.
      const [main, comments] = await Promise.all([
        board.getTicket(req.params.id),
        board.listComments(req.params.id).catch(() => [] as Awaited<ReturnType<typeof board.listComments>>),
      ]);
      res.json({ ticket: main.ticket, audit: main.audit, comments });
    } catch (err) { handleErr(res, err); }
  });

  app.get('/api/board/queue/:agent', async (req, res) => {
    try { res.json({ queue: await board.getQueue(req.params.agent.toUpperCase() as AgentCode) }); } catch (err) { handleErr(res, err); }
  });

  // ─── CEO inbox (Drop a Note → ticket) ───

  app.post('/api/notes', async (req, res) => {
    try {
      const { title, body, audience, type, assignee_agent } = req.body || {};
      if (!body || typeof body !== 'string' || body.length === 0) {
        return res.status(400).json({ error: 'body required' });
      }
      if (body.length > 5000) {
        return res.status(400).json({ error: 'body max 5000 chars' });
      }
      const finalTitle = (typeof title === 'string' && title.trim())
        ? title.trim().slice(0, 180)
        : firstLine(body).slice(0, 180);
      const ALLOWED_NOTE_ASSIGNEES: AgentCode[] = ['SA', 'AD', 'WA', 'DA', 'QA', 'WD', 'CEO', 'TA', 'PETER'];
      const finalAssignee: AgentCode = (typeof assignee_agent === 'string' && ALLOWED_NOTE_ASSIGNEES.includes(assignee_agent as AgentCode))
        ? assignee_agent as AgentCode
        : 'CEO';
      const ticket = await board.createTicket({
        title: finalTitle,
        body_md: body,
        type: (type as 'ops' | 'bug' | 'feature') || 'ops',
        audience: audience === 'app' ? 'app' : 'admin',
        status: 'triage',
        assignee_agent: finalAssignee,
      });
      events?.emitLocalTicketCreated(ticket);
      broadcast({ type: 'tickets_changed', data: { reason: 'note_created' } });
      res.json({ ticket });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ─── Ticket transitions ───

  app.post('/api/board/tickets/:id/start', async (req, res) => {
    try {
      const r = await board.start(req.params.id);
      events?.emitLocalTicketChanged(req.params.id, '', { status: r.status as Ticket['status'] }, ['status']);
      broadcast({ type: 'tickets_changed', data: { reason: 'start' } });
      res.json(r);
    } catch (err) { handleErr(res, err); }
  });
  app.post('/api/board/tickets/:id/handoff', async (req, res) => {
    try {
      const r = await board.handoff(req.params.id);
      events?.emitLocalTicketChanged(req.params.id, '', { status: r.status as Ticket['status'] }, ['status']);
      broadcast({ type: 'tickets_changed', data: { reason: 'handoff' } });
      res.json(r);
    } catch (err) { handleErr(res, err); }
  });
  app.post('/api/board/tickets/:id/done', async (req, res) => {
    try {
      const r = await board.done(req.params.id);
      if (r.status) events?.emitLocalTicketChanged(req.params.id, '', { status: r.status as Ticket['status'] }, ['status']);
      broadcast({ type: 'tickets_changed', data: { reason: 'done' } });
      res.json(r);
    } catch (err) { handleErr(res, err); }
  });
  app.post('/api/board/tickets/:id/comments', async (req, res) => {
    try {
      const body_md = req.body?.body_md;
      if (!body_md || typeof body_md !== 'string') return res.status(400).json({ error: 'body_md required' });
      if (body_md.length > 10000) return res.status(400).json({ error: 'body_md max 10000 chars' });
      const comment = await board.postComment(req.params.id, body_md);
      events?.emitLocalCommentAdded(req.params.id, '', comment);
      broadcast({ type: 'tickets_changed', data: { reason: 'comment' } });
      res.json({ comment });
    } catch (err) { handleErr(res, err); }
  });
  app.patch('/api/board/tickets/:id', async (req, res) => {
    try {
      const allowed: Record<string, unknown> = {};
      const fields = ['status', 'assignee_agent', 'audience', 'title', 'body_md', 'type'];
      for (const f of fields) if (req.body?.[f] !== undefined) allowed[f] = req.body[f];
      const result = await board.patch(req.params.id, allowed as Partial<Ticket>);
      events?.emitLocalTicketChanged(req.params.id, '', allowed as Partial<Ticket>, Object.keys(allowed));
      broadcast({ type: 'tickets_changed', data: { reason: 'patch' } });
      res.json(result);
    } catch (err) { handleErr(res, err); }
  });

  // ─── Copy-prompt helper ───

  app.get('/api/copy-prompt/:id', async (req, res) => {
    try {
      const { ticket } = await board.getTicket(req.params.id);
      const prompt = renderRelayPrompt(ticket.ticket_human_id, ticket.assignee_agent, ticket.title);
      res.json({ prompt });
    } catch (err) { handleErr(res, err); }
  });

  // ─── Kickoff prompts (PH-073) ───

  // PH-090 (re-scoped): kickoff prompts are file-backed Markdown at
  // SaaS Architect/<AGENT>-kickoff.md. GET reads, POST writes. No platform
  // DB dependency — MC owns the canonical source. If a file is missing on
  // first read, fall back to buildKickoffPrompt() so the button never
  // breaks; the operator should commit the file to make it persistent.
  app.get('/api/agents/:code/kickoff', (req, res) => {
    const code = req.params.code.toUpperCase() as AgentCode;
    if (!ALLOWED_AGENT_CODES_FOR_KICKOFF.includes(code)) {
      return res.status(400).json({ error: 'unknown agent code' });
    }
    const path = kickoffFilePath(code);
    let basePrompt: string;
    let source: 'file' | 'fallback';
    if (existsSync(path)) {
      basePrompt = readFileSync(path, 'utf-8');
      source = 'file';
    } else {
      basePrompt = buildKickoffPrompt(code);
      source = 'fallback';
    }
    // PH-118: append a "Scheduled tickets due now" block so post-compact
    // reorientation surfaces parked work whose moment has arrived. Block is
    // omitted when nothing is due, so existing flows are unchanged.
    const due = schedules.allDue();
    if (due.length) {
      const lines = due
        .slice()
        .sort((a, b) => (a.scheduled_for || '').localeCompare(b.scheduled_for || ''))
        .map((e) => {
          const id = e.ticket_human_id || e.ticket_id;
          const title = e.ticket_title ? ` — ${e.ticket_title}` : '';
          return `- 🔔 **${id}**${title} (scheduled for ${e.scheduled_for}, set by ${e.set_by})`;
        });
      basePrompt += `\n\n---\n\n## 🔔 Scheduled tickets now due (${due.length})\n${lines.join('\n')}\n`;
    }
    res.json({ agentCode: code, prompt: basePrompt, source, path });
  });

  app.post('/api/agents/:code/kickoff', (req, res) => {
    const code = req.params.code.toUpperCase() as AgentCode;
    if (!ALLOWED_AGENT_CODES_FOR_KICKOFF.includes(code)) {
      return res.status(400).json({ error: 'unknown agent code' });
    }
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return res.status(400).json({ error: 'prompt (string) required' });
    }
    if (prompt.length > 32_000) {
      return res.status(400).json({ error: 'prompt max 32000 chars' });
    }
    const path = kickoffFilePath(code);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, prompt, 'utf-8');
    logger.info({ code, bytes: prompt.length, path }, 'kickoff written');
    res.json({ agentCode: code, written: prompt.length, path });
  });

  // PH-092: goals are file-backed Markdown at SaaS Architect/<AGENT>-goals.md.
  // Same shape as kickoff (PH-090). Default seed if missing on read.
  app.get('/api/agents/:code/goals', (req, res) => {
    const code = req.params.code.toUpperCase() as AgentCode;
    if (!ALLOWED_AGENT_CODES_FOR_GOALS.includes(code)) {
      return res.status(400).json({ error: 'unknown agent code' });
    }
    const path = goalsFilePath(code);
    if (existsSync(path)) {
      const goals = readFileSync(path, 'utf-8');
      return res.json({ agentCode: code, goals, source: 'file', path });
    }
    res.json({ agentCode: code, goals: buildDefaultGoals(code), source: 'fallback', path });
  });

  app.post('/api/agents/:code/goals', (req, res) => {
    const code = req.params.code.toUpperCase() as AgentCode;
    if (!ALLOWED_AGENT_CODES_FOR_GOALS.includes(code)) {
      return res.status(400).json({ error: 'unknown agent code' });
    }
    const goals = req.body?.goals;
    if (typeof goals !== 'string' || goals.length === 0) {
      return res.status(400).json({ error: 'goals (string) required' });
    }
    if (goals.length > 32_000) {
      return res.status(400).json({ error: 'goals max 32000 chars' });
    }
    const path = goalsFilePath(code);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, goals, 'utf-8');
    logger.info({ code, bytes: goals.length, path }, 'goals written');
    res.json({ agentCode: code, written: goals.length, path });
  });

  app.get('/api/agents/:code/precompact', (req, res) => {
    const code = req.params.code.toUpperCase() as AgentCode;
    if (!ALLOWED_AGENT_CODES_FOR_PRECOMPACT.includes(code)) {
      return res.status(400).json({ error: 'unknown agent code (PETER excluded — human, no pre-compact)' });
    }
    const prompt = buildPrecompactPrompt(code);
    res.json({ agentCode: code, prompt });
  });

  // ─── Soul preview ───

  app.get('/api/agents/:code/soul', async (req, res) => {
    const code = req.params.code.toUpperCase() as AgentCode;
    // PH-090: try platform DB first, fall back to local soul/resume files.
    const live = await agentsKb.getSoul(code);
    if (live && live.length > 0) {
      return res.type('text/markdown').set('x-source', 'db').send(live);
    }
    const folderMap: Record<string, string> = {
      SA: 'SaaS Architect',
      AD: 'App Developer',
      WA: 'Workflow Architect',
      DA: 'Docs Agent',
      QA: 'QA Agent',
      WD: 'Website Developer',
      CEO: 'CEO',
      TA: 'Tooling Agent',
    };
    const candidates = [
      `/Users/peter/Desktop/Websites/prooflab/SaaS Architect/${folderMap[code] || code}/soul.md`,
      `/Users/peter/Desktop/Websites/prooflab/SaaS Architect/${code}-soul.md`,
      `/Users/peter/Desktop/Websites/prooflab/SaaS Architect/${code}-resume.md`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        return res.type('text/markdown').set('x-source', 'file').send(readFileSync(p, 'utf-8'));
      }
    }
    res.status(404).json({ error: 'no soul available — neither platform DB (PH-090 deploy pending) nor local file' });
  });

  // ─── Bug Lessons (PH-095 — proxies SA's PH-088 endpoints; degrades gracefully if not yet deployed) ───

  app.get('/api/board/lessons', async (req, res) => {
    try {
      const r = await board.lessonsList({
        q: req.query.q as string | undefined,
        tag: req.query.tag as string | undefined,
        severity: req.query.severity as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      res.json(r);
    } catch (err) {
      const status = err instanceof BoardError ? err.status : 500;
      res.json({ lessons: [], unavailable: true, reason: `upstream ${status}` });
    }
  });

  app.get('/api/board/lessons/:id', async (req, res) => {
    try { res.json(await board.lessonGet(req.params.id)); }
    catch (err) { handleErr(res, err); }
  });

  app.post('/api/board/lessons', async (req, res) => {
    try { res.json(await board.lessonCreate(req.body || {})); }
    catch (err) { handleErr(res, err); }
  });

  app.patch('/api/board/lessons/:id', async (req, res) => {
    try { res.json(await board.lessonPatch(req.params.id, req.body || {})); }
    catch (err) { handleErr(res, err); }
  });

  app.delete('/api/board/lessons/:id', async (req, res) => {
    try { res.json(await board.lessonDelete(req.params.id)); }
    catch (err) { handleErr(res, err); }
  });

  // ─── Webhook receiver (HMAC-validated) ───

  app.post('/webhook/board-event', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
    if (!config.webhookSecret) return res.status(503).json({ error: 'webhook secret not configured' });
    const sig = String(req.header('x-pp-signature') || '');
    const raw = req.body as Buffer;
    const expected = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
    const provided = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    try {
      const evt = JSON.parse(raw.toString('utf-8'));
      logger.info({ action: evt?.action }, 'webhook event');
      broadcast({ type: 'tickets_changed', data: { reason: 'webhook' } });
      const normalized = normalizeWebhookEvent(evt, req.header('x-pp-delivery-id') || sig);
      if (normalized) void processForInbox(normalized);
    } catch { /* ignore bad payloads */ }
    res.json({ ok: true });
  });

  // ─── CEO inbox (file-backed) ───

  app.get('/api/inbox', (_req, res) => {
    res.json({
      entries: inbox.list(),
      unprocessed: inbox.unprocessedCount(),
    });
  });

  // ─── Presence (PH-078) ───
  app.get('/api/board/presence', async (_req, res) => {
    const cached = presencePoller.snapshot();
    if (cached) return res.json({ presence: cached });
    try {
      res.json({ presence: await board.getPresence() });
    } catch (err) {
      // Upstream not deployed yet (PH-072 bundled-but-not-live). Degrade to
      // an empty list with a flag so the dashboard can render "no presence
      // data yet" rather than failing the whole boot sequence.
      res.json({ presence: [], unavailable: true, reason: err instanceof BoardError ? `upstream ${err.status}` : 'upstream error' });
    }
  });

  app.post('/api/board/agents/:code/pause', async (req, res) => {
    try {
      const code = req.params.code.toUpperCase() as AgentCode;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : undefined;
      const r = await board.pauseAgent(code, reason);
      res.json(r);
    } catch (err) { handleErr(res, err); }
  });

  app.post('/api/board/agents/:code/resume', async (req, res) => {
    try {
      const code = req.params.code.toUpperCase() as AgentCode;
      res.json(await board.resumeAgent(code));
    } catch (err) { handleErr(res, err); }
  });

  // ─── Compliance engine read-through (PH-127, consumes PH-126) ───

  app.get('/api/board/tickets/:id/eligible-actions', async (req, res) => {
    try { res.json(await board.eligibleActions(req.params.id)); } catch (err) { handleErr(res, err); }
  });

  app.get('/api/board/compliance/kill-switch', async (_req, res) => {
    try { res.json(await board.killSwitch()); } catch (err) { handleErr(res, err); }
  });

  // ─── Scheduled-for (PH-118) — MC-local file-backed store ───

  app.get('/api/board/schedules', (_req, res) => {
    res.json({ schedules: schedules.list() });
  });

  app.put('/api/board/tickets/:id/schedule', (req, res) => {
    const ticketId = req.params.id;
    const scheduledFor = req.body?.scheduled_for ?? req.body?.scheduledFor;
    if (!scheduledFor || typeof scheduledFor !== 'string') {
      return res.status(400).json({ error: 'scheduled_for required (ISO 8601)' });
    }
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'scheduled_for must parse as a date' });
    const ticketHumanId = (req.body?.ticket_human_id ?? req.body?.ticketHumanId ?? null) as string | null;
    const ticketTitle = (req.body?.ticket_title ?? req.body?.ticketTitle ?? null) as string | null;
    schedules.set({
      ticket_id: ticketId,
      ticket_human_id: ticketHumanId,
      ticket_title: ticketTitle,
      scheduled_for: when.toISOString(),
      set_by: identity.current,
      set_at: new Date().toISOString(),
    });
    broadcast({ type: 'tickets_changed', data: { reason: 'schedule_set' } });
    res.json({ success: true, schedule: schedules.get(ticketId) });
  });

  app.delete('/api/board/tickets/:id/schedule', (req, res) => {
    const removed = schedules.clear(req.params.id);
    if (removed) broadcast({ type: 'tickets_changed', data: { reason: 'schedule_cleared' } });
    res.json({ success: true, removed });
  });

  app.post('/api/inbox/processed', (req, res) => {
    const ids = Array.isArray(req.body?.delivery_ids) ? req.body.delivery_ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'delivery_ids required' });
    const added = inbox.markProcessed(ids);
    broadcast({ type: 'inbox_changed', data: { unprocessed: inbox.unprocessedCount() } });
    res.json({ marked: added, unprocessed: inbox.unprocessedCount() });
  });

  // Health
  app.get('/health', (_req, res) => res.json({ status: 'ok', agent: identity.current, apiBase: config.apiBase, inbox: inbox.unprocessedCount() }));

  // ─── HTTP + WS ───

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    send(ws, { type: 'hello', data: { agentCode: identity.current, serverTime: new Date().toISOString() } });
    ws.on('close', () => clients.delete(ws));
  });

  function send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
  function broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }

  events = new EventEmitter(board, logger, broadcast);

  // ─── Audit polling ───

  // ─── Presence (PH-078) — ticker + poller ───
  const presenceHeartbeat = new PresenceHeartbeat(
    board,
    () => identity.current,
    logger,
    (paused, reason) => {
      logger.info({ paused, reason }, 'pause state changed (heartbeat back-channel)');
      // Trigger an immediate presence broadcast so the dashboard reflects it.
      // The presence poller will catch up on its own cycle anyway.
      void presencePoller.start();
    },
  );
  presenceHeartbeat.start();

  const presencePoller = new PresencePoller(
    board,
    15_000,
    logger,
    (rows) => broadcast({ type: 'presence_changed', data: { presence: rows } }),
  );
  presencePoller.start();

  const poller = new AuditPoller(
    board,
    config.auditPollMs,
    logger,
    (row) => {
      broadcast({ type: 'audit_event', data: row });
      void processForInbox(normalizeAuditRow(row));
      void events?.emitFromAudit(row);
    },
    () => broadcast({ type: 'tickets_changed', data: { reason: 'audit' } }),
  );
  poller.start();

  const schedulePoller = new SchedulePoller(
    schedules,
    notifier,
    logger,
    () => broadcast({ type: 'tickets_changed', data: { reason: 'schedule_due' } }),
  );
  schedulePoller.start();

  // ─── Start ───

  process.on('SIGINT', () => { poller.stop(); presencePoller.stop(); presenceHeartbeat.stop(); schedulePoller.stop(); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { poller.stop(); presencePoller.stop(); presenceHeartbeat.stop(); schedulePoller.stop(); server.close(); process.exit(0); });

  server.listen(config.port, '127.0.0.1', () => {
    logger.info({ port: config.port }, `Mission Control running at http://localhost:${config.port}`);
    console.log(`\n  PrintPepper Mission Control v0.1`);
    console.log(`  http://localhost:${config.port}  (agent: ${config.agentCode})\n`);
  });
}

// ─── Helpers ───

function firstLine(s: string): string {
  return (s.split('\n')[0] || s).trim();
}

function renderRelayPrompt(humanId: string, assignee: string | null, title: string): string {
  if (!assignee) {
    return `${humanId} — needs an assignee before relay.\n\nTitle: ${title}\n\nAssign on the board (or via PATCH) before generating the relay prompt.\n`;
  }
  return `${humanId} — pull from board.

You have a new ticket assigned. Pull it now:

  curl -H "x-pp-agent-token: $AGENT_API_TOKEN" -H "x-pp-agent-id: ${assignee}" \\
    https://admin.printpepper.co.uk/api/admin/tickets/queue?assignee=${assignee}

Read the body, references, and last 10 comments. Move to In Progress (POST /start). Work in lane. Post your CEO summary as a comment on the ticket. Hand off (POST /handoff) when done.

Title: ${title}
`;
}

function normalizeAuditRow(row: AuditRow): NormalizedEvent {
  const d = row.details || {};
  // For ticket.assigned, audit puts the new assignee in details.to (sometimes
  // also details.assignee_agent for ticket.created). details.agent_id is the actor.
  const newAssignee = (d.assignee_agent ?? d.to) as string | undefined;
  return {
    delivery_id: `audit:${row.id}`,
    source: 'audit',
    action: row.action,
    ticket_id: (d.id as string | undefined) ?? (d.ticket_id as string | undefined) ?? null,
    ticket_human_id: row.target,
    actor: (d.agent_id as string | undefined) ?? row.actor_kind ?? null,
    ts: row.created_at,
    hint_assignee_agent: newAssignee ?? null,
    hint_audience: (d.audience as string | undefined) ?? null,
    hint_status: (d.status as string | undefined) ?? null,
    hint_title: (d.title as string | undefined) ?? null,
  };
}

function normalizeWebhookEvent(evt: Record<string, unknown>, deliveryId: string): NormalizedEvent | null {
  const action = typeof evt.action === 'string' ? evt.action : null;
  if (!action) return null;
  const t = (evt.ticket || evt.data || {}) as Record<string, unknown>;
  return {
    delivery_id: `webhook:${deliveryId}`,
    source: 'webhook',
    action,
    ticket_id: (t.id as string | undefined) ?? null,
    ticket_human_id: (t.ticket_human_id as string | undefined) ?? (evt.target as string | undefined) ?? null,
    actor: (evt.actor as string | undefined) ?? null,
    ts: (evt.ts as string | undefined) ?? new Date().toISOString(),
    hint_assignee_agent: (t.assignee_agent as string | undefined) ?? null,
    hint_audience: (t.audience as string | undefined) ?? null,
    hint_status: (t.status as string | undefined) ?? null,
    hint_title: (t.title as string | undefined) ?? null,
  };
}

function handleErr(res: express.Response, err: unknown): void {
  if (err instanceof BoardError) {
    res.status(err.status).json({ error: 'upstream_error', status: err.status, body: err.body });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
