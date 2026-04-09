import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, resolve, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { initLogger, rotateLogs } from './logger.js';
import { SafetyModule } from './safety.js';
import { TaskManager } from './tasks.js';
import { AgentAdapter } from './agent-adapter.js';
import { HeartbeatScheduler } from './heartbeat.js';
import { McpServer } from './mcp-server.js';
import type { EunomiaConfig, WsMessage, HealthResponse } from './types.js';
import { DEFAULT_CONFIG, DEFAULT_SAFETY_CONFIG } from './types.js';
import type { Logger } from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ───

function parseArgs(): EunomiaConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      config.projectPath = resolve(args[++i]);
    }
    if (args[i] === '--port' && args[i + 1]) {
      config.port = parseInt(args[++i]);
    }
    if (args[i] === '--model' && args[i + 1]) {
      config.ceoModel = args[++i];
    }
  }

  if (!config.projectPath) {
    console.error('Usage: eunomia --project /path/to/your/code [--port 4600] [--model claude-sonnet-4-6]');
    process.exit(1);
  }

  // Load config file if exists
  const configPath = join(config.projectPath, 'eunomia.config.json');
  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (fileConfig.port) config.port = fileConfig.port;
      if (fileConfig.ceoModel) config.ceoModel = fileConfig.ceoModel;
      if (fileConfig.safety) {
        config.safety = { ...DEFAULT_SAFETY_CONFIG, ...fileConfig.safety };
      }
    } catch {
      // Ignore bad config
    }
  }

  return config;
}

// ─── Project Init ───

function initProject(projectPath: string, ceoModel: string): void {
  mkdirSync(join(projectPath, 'ceo'), { recursive: true });
  mkdirSync(join(projectPath, 'workers'), { recursive: true });

  // PROJECT.md
  if (!existsSync(join(projectPath, 'PROJECT.md'))) {
    let projectName = projectPath.split('/').pop() || 'Project';

    // Try to extract from package.json or README
    let discoveredContext = '';
    const pkgPath = join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name) projectName = pkg.name;
        if (pkg.description) discoveredContext += `\n${pkg.description}\n`;
      } catch { /* ignore */ }
    }
    const readmePath = join(projectPath, 'README.md');
    if (existsSync(readmePath)) {
      try {
        const readme = readFileSync(readmePath, 'utf-8');
        const firstParagraph = readme.split('\n\n').slice(0, 2).join('\n\n');
        if (firstParagraph.length < 1000) {
          discoveredContext += `\n${firstParagraph}\n`;
        }
      } catch { /* ignore */ }
    }

    writeFileSync(
      join(projectPath, 'PROJECT.md'),
      `# PROJECT — ${projectName}

## Mission

[Describe what you are building and why. Keep under 1,000 words.]
${discoveredContext}

## Goals

- [ ] [Goal 1]
- [ ] [Goal 2]
- [ ] [Goal 3]

## Constraints

- **Budget:** Stay under $${DEFAULT_SAFETY_CONFIG.maxDailyBudgetUsd}/day
- **Workers:** Max ${DEFAULT_SAFETY_CONFIG.maxConcurrentWorkers} concurrent

## File Map

| Path | What |
|------|------|
| \`${projectPath}\` | Project root |
`,
    );
  }

  // CEO SOUL.md
  if (!existsSync(join(projectPath, 'ceo', 'SOUL.md'))) {
    writeFileSync(
      join(projectPath, 'ceo', 'SOUL.md'),
      `# SOUL — CEO Agent

## Identity
- **Name:** CEO
- **Role:** Strategic planning, task delegation, worker review
- **Model:** ${ceoModel}

## What You Do
You plan and coordinate work for this project. You break the mission into tasks, decide which need a specialist worker, spawn them via MCP tools, and review their output. You delegate implementation — you do not write code yourself.

## How You Work
- Read PROJECT.md for the mission and company goals
- Read GOALS.md for your KPIs
- Check TASKS.md for current task status
- Use MCP tools (tasks_create, tasks_update, spawn_worker) to manage work
- Review completed worker output in workers/{task-id}/output/
- Write key decisions to MEMORY.md — specific, not generic
- Before re-spawning a failed task, check if the worker left useful output

## Rules
- Be concise. Short updates, short memory entries.
- Don't re-read files you've already read this session unless they've changed.
- Don't write generic summaries to MEMORY.md. Only specific decisions, blockers, discoveries.
- Respect token budgets. Efficiency is a virtue.
- Max ${DEFAULT_SAFETY_CONFIG.maxConcurrentWorkers} concurrent workers.

## Boundaries
- You can read any file in the project folder
- You can write to ceo/ and manage tasks via MCP tools
- You cannot modify source code directly — delegate to workers
- When unsure, note it in TASKS.md for the human to decide

## Personality
Direct, no fluff. Lead with the decision, then the reasoning.
`,
    );
  }

  // CEO GOALS.md
  if (!existsSync(join(projectPath, 'ceo', 'GOALS.md'))) {
    writeFileSync(
      join(projectPath, 'ceo', 'GOALS.md'),
      `# GOALS — CEO Agent

## KPIs

| KPI | Target | Measure |
|-----|--------|---------|
| Task throughput | 5 tasks delegated/day | Tasks moved to active |
| Worker success rate | 80%+ first-attempt pass | Tasks not marked failed |
| Token efficiency | < $${DEFAULT_SAFETY_CONFIG.maxDailyBudgetUsd}/day | Daily spend tracking |

## Current Sprint Goals

- [ ] Read PROJECT.md and understand the mission
- [ ] Break the mission into initial tasks
- [ ] Delegate first task to a worker

## Standing Orders

- Always check worker output before moving a task to Done
- Flag any task that's been Active for more than 30 minutes
- If a worker fails, note why before re-attempting
`,
    );
  }

  // CEO MEMORY.md
  if (!existsSync(join(projectPath, 'ceo', 'MEMORY.md'))) {
    writeFileSync(join(projectPath, 'ceo', 'MEMORY.md'), '# Memory\n\n_No entries yet._\n');
  }

  // TASKS.md
  if (!existsSync(join(projectPath, 'TASKS.md'))) {
    writeFileSync(
      join(projectPath, 'TASKS.md'),
      `# Tasks

## Planned

_No tasks_

## Active

_No tasks_

## Done

_No tasks_

## Failed

_No tasks_
`,
    );
  }
}

// ─── Main ───

async function main() {
  const config = parseArgs();
  const logger = initLogger(config.projectPath);
  rotateLogs();

  logger.info({ projectPath: config.projectPath, port: config.port, model: config.ceoModel }, 'Eunomia starting');

  // Init project structure
  initProject(config.projectPath, config.ceoModel);

  // Core modules
  const safety = new SafetyModule(config.safety, logger);
  const tasks = new TaskManager(config.projectPath, logger);
  const adapter = new AgentAdapter(logger);
  await adapter.init();

  // Orphan cleanup
  const orphaned = tasks.markOrphanedTasksFailed();
  if (orphaned > 0) {
    logger.warn({ count: orphaned }, 'Cleaned up orphaned tasks');
  }

  const heartbeat = new HeartbeatScheduler(logger, safety, tasks, adapter);
  const mcp = new McpServer(tasks, adapter, safety, heartbeat, logger, config.projectPath);

  // ─── Express + HTTP ───

  const app = express();
  app.use(express.json());

  // Dashboard static files
  const dashboardDir = join(__dirname, '..', 'dashboard');
  // Fallback to src directory during dev
  const staticDir = existsSync(dashboardDir) ? dashboardDir : join(__dirname, '..', '..', 'src', 'dashboard');
  app.use(express.static(staticDir));

  // Health endpoint
  app.get('/health', (_req, res) => {
    const ceo = adapter.getCeoSession();
    const mem = process.memoryUsage();
    const counts = tasks.getStatusCounts();

    const health: HealthResponse = {
      status: safety.isPaused() ? 'degraded' : 'ok',
      uptime: Math.floor(process.uptime()),
      ceo: {
        status: ceo?.status || 'not_started',
        model: config.ceoModel,
        sessionAge: ceo ? formatDuration(Date.now() - new Date(ceo.info.startedAt).getTime()) : '0s',
        tokensToday: (ceo?.info.tokensInput ?? 0) + (ceo?.info.tokensOutput ?? 0),
        costToday: safety.getDailySpend(),
      },
      workers: {
        active: adapter.getActiveWorkerCount(),
        max: config.safety.maxConcurrentWorkers,
      },
      budget: {
        spent: safety.getDailySpend(),
        limit: config.safety.maxDailyBudgetUsd,
        percent: safety.getBudgetPercent(),
      },
      tasks: counts,
      memory: {
        rss: formatBytes(mem.rss),
        heapUsed: formatBytes(mem.heapUsed),
      },
    };
    res.json(health);
  });

  // Tasks API
  app.get('/api/tasks', (_req, res) => {
    res.json(tasks.getState());
  });

  app.get('/api/tasks/content', (_req, res) => {
    res.type('text/markdown').send(tasks.getTasksContent());
  });

  app.post('/api/tasks', async (req, res) => {
    safety.recordHumanInteraction();
    const task = await tasks.createTask(req.body);
    heartbeat.notifyTaskChange();
    broadcast({ type: 'tasks_updated', data: tasks.getState(), timestamp: new Date().toISOString() });
    res.json(task);
  });

  app.patch('/api/tasks/:id', async (req, res) => {
    safety.recordHumanInteraction();
    const task = await tasks.updateTask(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    heartbeat.notifyTaskChange();
    broadcast({ type: 'tasks_updated', data: tasks.getState(), timestamp: new Date().toISOString() });
    res.json(task);
  });

  // Agent status API
  app.get('/api/agents', (_req, res) => {
    const sessions = adapter.getAllSessions().map((s) => ({
      id: s.id,
      role: s.role,
      taskId: s.taskId,
      status: s.status,
      info: adapter.getSessionInfo(s.id),
    }));
    res.json(sessions);
  });

  // Safety API
  app.get('/api/safety', (_req, res) => {
    res.json({
      config: safety.getConfig(),
      paused: safety.isPaused(),
      budgetPercent: safety.getBudgetPercent(),
      dailySpend: safety.getDailySpend(),
      inactiveMinutes: safety.getInactivityMinutes(),
      pendingApprovals: safety.getPendingApprovals(),
    });
  });

  app.post('/api/safety/pause', (_req, res) => {
    safety.recordHumanInteraction();
    safety.pause('Human requested pause');
    heartbeat.pause();
    broadcast({ type: 'safety_alert', data: { action: 'paused' }, timestamp: new Date().toISOString() });
    res.json({ paused: true });
  });

  app.post('/api/safety/resume', (_req, res) => {
    safety.recordHumanInteraction();
    safety.resume();
    heartbeat.resume();
    broadcast({ type: 'safety_alert', data: { action: 'resumed' }, timestamp: new Date().toISOString() });
    res.json({ paused: false });
  });

  app.post('/api/safety/approve/:taskId', (req, res) => {
    safety.recordHumanInteraction();
    safety.resolveApproval(req.params.taskId, true);
    res.json({ approved: true });
  });

  app.post('/api/safety/reject/:taskId', (req, res) => {
    safety.recordHumanInteraction();
    safety.resolveApproval(req.params.taskId, false);
    res.json({ approved: false });
  });

  app.patch('/api/safety/config', (req, res) => {
    safety.recordHumanInteraction();
    safety.updateConfig(req.body);
    res.json(safety.getConfig());
  });

  // Heartbeat API
  app.get('/api/heartbeat', (_req, res) => {
    res.json(heartbeat.getState());
  });

  // Prompt CEO
  app.post('/api/prompt', async (req, res) => {
    safety.recordHumanInteraction();
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const ceo = adapter.getCeoSession();
    if (!ceo) return res.status(503).json({ error: 'CEO not running' });

    try {
      await adapter.sendMessage(ceo.id, message);
      res.json({ sent: true });
    } catch (err) {
      res.status(500).json({ error: `Failed to send: ${err}` });
    }
  });

  // Kill worker
  app.post('/api/agents/:id/kill', async (req, res) => {
    safety.recordHumanInteraction();
    const session = adapter.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Agent not found' });

    await adapter.killSession(req.params.id);

    // Mark task as failed
    if (session.taskId) {
      await tasks.updateTask(session.taskId, {
        status: 'failed',
        notes: 'Killed by human',
      });
      heartbeat.notifyTaskChange();
    }

    broadcast({ type: 'tasks_updated', data: tasks.getState(), timestamp: new Date().toISOString() });
    res.json({ killed: true });
  });

  // ─── WebSocket ───

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info({ clients: clients.size }, 'WebSocket client connected');

    // Send initial state
    ws.send(JSON.stringify({
      type: 'tasks_updated',
      data: tasks.getState(),
      timestamp: new Date().toISOString(),
    }));

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'prompt' && msg.message) {
          safety.recordHumanInteraction();
          const ceo = adapter.getCeoSession();
          if (ceo) {
            adapter.sendMessage(ceo.id, msg.message).catch((err) => {
              logger.error({ err }, 'Failed to send prompt via WebSocket');
            });
          }
        }
      } catch { /* ignore bad messages */ }
    });
  });

  function broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // ─── Agent Output → WebSocket ───

  function onAgentOutput(agentId: string) {
    return (data: string) => {
      broadcast({
        type: 'terminal_output',
        agentId,
        data,
        timestamp: new Date().toISOString(),
      });
    };
  }

  // ─── Cost Tracking ───

  adapter.setOnCostUpdate((agentId, costUsd, tokensInput, tokensOutput) => {
    safety.recordSpend(costUsd);
    logger.info({ agentId, costUsd: costUsd.toFixed(4), tokensInput, tokensOutput }, 'Cost update');
  });

  // ─── Worker lifecycle ───

  // Wire worker output streaming to dashboard
  mcp.setOnWorkerOutput((agentId: string) => onAgentOutput(agentId));

  mcp.setOnWorkerSpawned((agentId, taskId) => {
    broadcast({
      type: 'agent_status',
      agentId,
      data: { status: 'running', taskId },
      timestamp: new Date().toISOString(),
    });
  });

  // Wire spawn approval notifications to dashboard
  mcp.setOnSpawnApprovalNeeded((taskId, task) => {
    broadcast({
      type: 'spawn_approval_request',
      data: { taskId, title: task.title, model: task.model },
      timestamp: new Date().toISOString(),
    });
  });

  // Shutdown endpoint
  app.post('/api/shutdown', async (_req, res) => {
    res.json({ shutting_down: true });
    shutdown('API');
  });

  // Worker timeout checker + system health loop
  let ceoRestartPending = false;

  setInterval(async () => {
    // Worker timeouts
    for (const session of adapter.getActiveSessions('worker')) {
      const startTime = new Date(session.info.startedAt).getTime();
      if (safety.isWorkerTimedOut(startTime)) {
        logger.warn({ agentId: session.id, taskId: session.taskId }, 'Worker timed out');
        try {
          await adapter.killSession(session.id);
          if (session.taskId) {
            const current = tasks.getTask(session.taskId);
            await tasks.updateTask(session.taskId, {
              status: 'failed',
              notes: 'Worker timed out',
              retryCount: (current?.retryCount ?? 0) + 1,
            });
            heartbeat.notifyTaskChange();
            broadcast({ type: 'tasks_updated', data: tasks.getState(), timestamp: new Date().toISOString() });
          }
        } catch (err) {
          logger.error({ err, agentId: session.id }, 'Failed to kill timed-out worker');
        }
      }
    }

    // CEO session age check (guarded against double restart)
    const ceo = adapter.getCeoSession();
    if (!ceoRestartPending && ceo && safety.shouldRestartCeo(new Date(ceo.info.startedAt).getTime())) {
      ceoRestartPending = true;
      logger.info('CEO session age limit reached — restarting');
      try {
        await adapter.sendMessage(ceo.id, 'Session age limit reached. Write critical context to MEMORY.md now.');
        await new Promise((r) => setTimeout(r, 15000));
      } catch { /* ignore */ }
      await adapter.killSession(ceo.id);
      await startCeo();
      ceoRestartPending = false;
    }

    // Inactivity check
    if (safety.isInactive() && !safety.isPaused()) {
      logger.info({ inactiveMinutes: safety.getInactivityMinutes() }, 'Auto-pausing due to inactivity');
      safety.pause('Human inactive');
      heartbeat.pause();
      broadcast({
        type: 'safety_alert',
        data: { action: 'paused', reason: 'Human inactive' },
        timestamp: new Date().toISOString(),
      });
    }

    // MEMORY.md rotation check
    rotateMemory(join(config.projectPath, 'ceo'), logger);

    // Cost update broadcast
    broadcast({
      type: 'cost_update',
      data: {
        dailySpend: safety.getDailySpend(),
        budgetPercent: safety.getBudgetPercent(),
        warning: safety.isBudgetWarning(),
        exhausted: safety.isBudgetExhausted(),
      },
      timestamp: new Date().toISOString(),
    });
  }, 30000);

  // ─── Start CEO ───

  async function startCeo() {
    // Build MCP server config for the CEO using the SDK's createSdkMcpServer
    let mcpServers: Record<string, unknown> | undefined;
    const { getCreateSdkMcpServerFn, getToolFn } = await import('./agent-adapter.js');
    const createMcp = getCreateSdkMcpServerFn();
    const toolBuilder = getToolFn();

    if (createMcp && toolBuilder) {
      // Build SDK MCP tools using the tool() helper
      const z = await import('zod').then(m => m.z).catch(() => null);
      if (z) {
        const sdkTools = buildSdkMcpTools(mcp, z, toolBuilder);
        const mcpConfig = createMcp({ name: 'eunomia', tools: sdkTools });
        mcpServers = { eunomia: mcpConfig };
        logger.info({ toolCount: sdkTools.length }, 'MCP server created for CEO');
      }
    }

    if (!mcpServers) {
      logger.warn('Could not create SDK MCP server — CEO will run without MCP tools');
    }

    const ceoSession = await adapter.spawnSession(
      'ceo',
      {
        model: config.ceoModel,
        cwd: join(config.projectPath, 'ceo'),
        additionalDirectories: [config.projectPath],
        persistSession: true,
        permissionMode: 'auto',
        mcpServers,
      },
      onAgentOutput('ceo'),
    );

    heartbeat.setCeoAgentId(ceoSession.id);
    heartbeat.start();

    logger.info({ agentId: ceoSession.id, model: config.ceoModel }, 'CEO started');
    broadcast({
      type: 'agent_status',
      agentId: ceoSession.id,
      data: { status: 'running', role: 'ceo' },
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Graceful Shutdown ───

  async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutdown initiated');

    // 1. Stop heartbeat
    heartbeat.stop();

    // 2. Send CEO shutdown message
    const ceo = adapter.getCeoSession();
    if (ceo) {
      try {
        await adapter.sendMessage(ceo.id, 'Server shutting down. Write critical context to MEMORY.md now.');
        await new Promise((r) => setTimeout(r, Math.min(30000, 10000))); // Wait up to 10s in practice
      } catch { /* ignore */ }
    }

    // 3. Kill all workers
    const workers = adapter.getActiveSessions('worker');
    for (const w of workers) {
      if (w.taskId) {
        await tasks.updateTask(w.taskId, { status: 'failed', notes: 'Server shutdown' });
      }
      await adapter.killSession(w.id);
    }

    // 4. Kill CEO
    if (ceo) await adapter.killSession(ceo.id);

    // 5. Cleanup
    tasks.destroy();

    // 6. Close WebSockets
    for (const client of clients) {
      client.close(1001, 'Server shutting down');
    }

    const totalSpend = safety.getDailySpend();
    logger.info({ totalSpend: totalSpend.toFixed(2) }, 'Eunomia stopped');
    server.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ─── Start Server ───

  server.listen(config.port, () => {
    logger.info({ port: config.port, project: config.projectPath }, `Eunomia running at http://localhost:${config.port}`);
    console.log(`\n  Eunomia running at http://localhost:${config.port}`);
    console.log(`  Project: ${config.projectPath}`);
    console.log(`  CEO Model: ${config.ceoModel}\n`);
    startCeo();
  });
}

// ─── Helpers ───

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

// ─── MEMORY.md Rotation ───

function rotateMemory(ceoDir: string, logger: Logger): void {
  const memPath = join(ceoDir, 'MEMORY.md');
  const archivePath = join(ceoDir, 'MEMORY-archive.md');

  if (!existsSync(memPath)) return;

  try {
    const content = readFileSync(memPath, 'utf-8');
    const lines = content.split('\n');

    if (lines.length <= 50) return;

    // Move all content to archive (append)
    const archiveContent = existsSync(archivePath) ? readFileSync(archivePath, 'utf-8') : '';
    const newArchive = archiveContent + '\n---\n' + content;

    // Cap archive at 200 lines (keep newest)
    const archiveLines = newArchive.split('\n');
    const cappedArchive = archiveLines.length > 200
      ? archiveLines.slice(archiveLines.length - 200).join('\n')
      : newArchive;

    writeFileSync(archivePath, cappedArchive, 'utf-8');
    writeFileSync(memPath, '# Memory\n\n_Rotated to MEMORY-archive.md. Write new entries below._\n', 'utf-8');

    logger.info({ lines: lines.length }, 'MEMORY.md rotated');
  } catch (err) {
    logger.error({ err }, 'Failed to rotate MEMORY.md');
  }
}

// ─── SDK MCP Tool Builder ───

function buildSdkMcpTools(mcp: McpServer, z: typeof import('zod').z, toolFn: (...args: unknown[]) => unknown): unknown[] {
  const tool = toolFn as (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) => unknown;

  return [
    tool('tasks_list', 'List tasks from TASKS.md, optionally filtered by status', {
      status: z.enum(['planned', 'active', 'done', 'failed']).optional(),
    }, async (args) => mcp.handleToolCall('tasks_list', args)),

    tool('tasks_create', 'Create a new task in Planned status', {
      title: z.string(),
      description: z.string().optional(),
      model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      maxBudgetUsd: z.number().optional(),
    }, async (args) => mcp.handleToolCall('tasks_create', args)),

    tool('tasks_update', 'Update a task status, notes, priority, or model', {
      taskId: z.string(),
      status: z.enum(['planned', 'active', 'done', 'failed']).optional(),
      notes: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
    }, async (args) => mcp.handleToolCall('tasks_update', args)),

    tool('spawn_worker', 'Spawn a temporary worker agent for a specific planned task', {
      taskId: z.string(),
    }, async (args) => mcp.handleToolCall('spawn_worker', args)),

    tool('worker_status', 'Check if a worker is running, its elapsed time and token spend', {
      agentId: z.string(),
    }, async (args) => mcp.handleToolCall('worker_status', args)),

    tool('kill_worker', 'Force-stop a running worker', {
      agentId: z.string(),
    }, async (args) => mcp.handleToolCall('kill_worker', args)),

    tool('list_workers', 'List all active workers with task, runtime, and cost', {}, async (args) => mcp.handleToolCall('list_workers', args)),
  ];
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
