import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { initLogger } from './logger.js';
import { PrintPepperBoardClient, BoardError } from './board-client.js';
import { AuditPoller } from './audit-poller.js';
import { deriveAgentStates } from './agent-state.js';
import { AGENT_LIST } from './types.js';
import type { AgentCode, MissionConfig, WsMessage } from './types.js';

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
  if (process.env.PP_AGENT_CODE) agentCode = process.env.PP_AGENT_CODE as AgentCode;

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

  const board = new PrintPepperBoardClient(config.apiBase, config.agentToken, config.agentCode);

  // ─── Express ───

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Static dashboard
  const dashboardDir = join(__dirname, '..', 'dashboard');
  const staticDir = existsSync(dashboardDir) ? dashboardDir : join(__dirname, '..', '..', 'src', 'dashboard');
  app.use(express.static(staticDir));

  // Identity (used by dashboard)
  app.get('/api/me', (_req, res) => {
    res.json({ agentCode: config.agentCode, apiBase: config.apiBase });
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
    try { res.json(await board.getTicket(req.params.id)); } catch (err) { handleErr(res, err); }
  });

  app.get('/api/board/queue/:agent', async (req, res) => {
    try { res.json({ queue: await board.getQueue(req.params.agent.toUpperCase() as AgentCode) }); } catch (err) { handleErr(res, err); }
  });

  // ─── CEO inbox (Drop a Note → ticket) ───

  app.post('/api/notes', async (req, res) => {
    try {
      const { title, body, audience, type } = req.body || {};
      if (!body || typeof body !== 'string' || body.length === 0) {
        return res.status(400).json({ error: 'body required' });
      }
      if (body.length > 5000) {
        return res.status(400).json({ error: 'body max 5000 chars' });
      }
      const finalTitle = (typeof title === 'string' && title.trim())
        ? title.trim().slice(0, 180)
        : firstLine(body).slice(0, 180);
      const ticket = await board.createTicket({
        title: finalTitle,
        body_md: body,
        type: (type as 'ops' | 'bug' | 'feature') || 'ops',
        audience: audience === 'app' ? 'app' : 'admin',
        status: 'triage',
        assignee_agent: 'CEO',
      });
      broadcast({ type: 'tickets_changed', data: { reason: 'note_created' } });
      res.json({ ticket });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ─── Ticket transitions ───

  app.post('/api/board/tickets/:id/start', async (req, res) => {
    try { res.json({ ticket: await board.start(req.params.id) }); broadcast({ type: 'tickets_changed', data: { reason: 'start' } }); } catch (err) { handleErr(res, err); }
  });
  app.post('/api/board/tickets/:id/handoff', async (req, res) => {
    try { res.json({ ticket: await board.handoff(req.params.id) }); broadcast({ type: 'tickets_changed', data: { reason: 'handoff' } }); } catch (err) { handleErr(res, err); }
  });
  app.post('/api/board/tickets/:id/done', async (req, res) => {
    try { res.json({ ticket: await board.done(req.params.id) }); broadcast({ type: 'tickets_changed', data: { reason: 'done' } }); } catch (err) { handleErr(res, err); }
  });
  app.post('/api/board/tickets/:id/comments', async (req, res) => {
    try {
      const body_md = req.body?.body_md;
      if (!body_md || typeof body_md !== 'string') return res.status(400).json({ error: 'body_md required' });
      if (body_md.length > 10000) return res.status(400).json({ error: 'body_md max 10000 chars' });
      const comment = await board.postComment(req.params.id, body_md);
      broadcast({ type: 'tickets_changed', data: { reason: 'comment' } });
      res.json({ comment });
    } catch (err) { handleErr(res, err); }
  });
  app.patch('/api/board/tickets/:id', async (req, res) => {
    try {
      const allowed: Record<string, unknown> = {};
      const fields = ['status', 'assignee_agent', 'audience', 'title', 'body_md', 'type'];
      for (const f of fields) if (req.body?.[f] !== undefined) allowed[f] = req.body[f];
      const ticket = await board.patch(req.params.id, allowed);
      broadcast({ type: 'tickets_changed', data: { reason: 'patch' } });
      res.json({ ticket });
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

  // ─── Soul preview ───

  app.get('/api/agents/:code/soul', (req, res) => {
    const code = req.params.code.toUpperCase();
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
        return res.type('text/markdown').send(readFileSync(p, 'utf-8'));
      }
    }
    res.status(404).json({ error: 'soul file not found yet (PH-036 will publish via API)' });
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
    } catch { /* ignore bad payloads */ }
    res.json({ ok: true });
  });

  // Health
  app.get('/health', (_req, res) => res.json({ status: 'ok', agent: config.agentCode, apiBase: config.apiBase }));

  // ─── HTTP + WS ───

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    send(ws, { type: 'hello', data: { agentCode: config.agentCode, serverTime: new Date().toISOString() } });
    ws.on('close', () => clients.delete(ws));
  });

  function send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
  function broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }

  // ─── Audit polling ───

  const poller = new AuditPoller(
    board,
    config.auditPollMs,
    logger,
    (row) => broadcast({ type: 'audit_event', data: row }),
    () => broadcast({ type: 'tickets_changed', data: { reason: 'audit' } }),
  );
  poller.start();

  // ─── Start ───

  process.on('SIGINT', () => { poller.stop(); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { poller.stop(); server.close(); process.exit(0); });

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
