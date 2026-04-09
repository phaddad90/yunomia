import type { TaskManager } from './tasks.js';
import type { AgentAdapter } from './agent-adapter.js';
import type { SafetyModule } from './safety.js';
import type { HeartbeatScheduler } from './heartbeat.js';
import type { MetricsCollector } from './metrics.js';
import type { ModelChoice, TaskPriority } from './types.js';
import type { Logger } from 'pino';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

/**
 * Eunomia MCP Server — in-process, exposed to CEO only.
 *
 * 7 tools:
 * - tasks_list: Read tasks filtered by status
 * - tasks_create: Add a task to Planned
 * - tasks_update: Update task status/notes/priority
 * - spawn_worker: Create a temporary worker for a task
 * - worker_status: Check worker runtime + cost
 * - kill_worker: Force-stop a worker
 * - list_workers: See all active workers
 *
 * Every handler is wrapped in try/catch — errors return structured
 * responses to the CEO, never crash the server.
 */

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class McpServer {
  private tasks: TaskManager;
  private adapter: AgentAdapter;
  private safety: SafetyModule;
  private heartbeat: HeartbeatScheduler;
  private logger: Logger;
  private projectPath: string;
  private metrics?: MetricsCollector;
  private onWorkerSpawned?: (agentId: string, taskId: string) => void;
  private onWorkerOutput?: (agentId: string) => (data: string) => void;
  private onSpawnApprovalNeeded?: (taskId: string, task: { title: string; model: string }) => void;

  constructor(
    tasks: TaskManager,
    adapter: AgentAdapter,
    safety: SafetyModule,
    heartbeat: HeartbeatScheduler,
    logger: Logger,
    projectPath: string,
    metrics?: MetricsCollector,
  ) {
    this.tasks = tasks;
    this.adapter = adapter;
    this.safety = safety;
    this.heartbeat = heartbeat;
    this.logger = logger;
    this.projectPath = projectPath;
    this.metrics = metrics;
  }

  setOnWorkerSpawned(cb: (agentId: string, taskId: string) => void): void {
    this.onWorkerSpawned = cb;
  }

  setOnWorkerOutput(cb: (agentId: string) => (data: string) => void): void {
    this.onWorkerOutput = cb;
  }

  setOnSpawnApprovalNeeded(cb: (taskId: string, task: { title: string; model: string }) => void): void {
    this.onSpawnApprovalNeeded = cb;
  }

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return [
      {
        name: 'tasks_list',
        description: 'List tasks from TASKS.md. Optionally filter by status.',
        input_schema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['planned', 'active', 'done', 'failed'],
              description: 'Filter by status. Omit for all tasks.',
            },
          },
        },
      },
      {
        name: 'tasks_create',
        description: 'Create a new task in Planned status.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            description: { type: 'string', description: 'Task description' },
            model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Model for the worker' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            maxBudgetUsd: { type: 'number', description: 'Max budget in USD for this task' },
          },
          required: ['title'],
        },
      },
      {
        name: 'tasks_update',
        description: 'Update a task. Can change status, notes, priority, model.',
        input_schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID (e.g. task-042)' },
            status: { type: 'string', enum: ['planned', 'active', 'done', 'failed'] },
            notes: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'spawn_worker',
        description: 'Spawn a temporary worker agent for a specific task. The worker will complete the task and be killed automatically.',
        input_schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to assign to the worker' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'worker_status',
        description: 'Check if a specific worker is still running, its elapsed time and token spend.',
        input_schema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Worker agent ID' },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'kill_worker',
        description: 'Force-stop a running worker.',
        input_schema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Worker agent ID to kill' },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'list_workers',
        description: 'List all active workers with their task, runtime, and cost.',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleToolCall(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'tasks_list':
          return this.tasksList(input);
        case 'tasks_create':
          return await this.tasksCreate(input);
        case 'tasks_update':
          return await this.tasksUpdate(input);
        case 'spawn_worker':
          return await this.spawnWorker(input);
        case 'worker_status':
          return this.workerStatus(input);
        case 'kill_worker':
          return await this.killWorker(input);
        case 'list_workers':
          return this.listWorkers();
        default:
          return this.error(`Unknown tool: ${toolName}`);
      }
    } catch (err) {
      this.logger.error({ toolName, input, err }, 'MCP tool call failed');
      return this.error(`Tool ${toolName} failed: ${err}`);
    }
  }

  // ─── Tool Implementations ───

  private tasksList(input: Record<string, unknown>): ToolResult {
    const status = input.status as string | undefined;
    const tasks = this.tasks.listTasks(status ? { status: status as 'planned' | 'active' | 'done' | 'failed' } : undefined);
    const lines = tasks.map((t) => {
      let line = `[${t.status}] ${t.id}: ${t.title} (${t.model}, ${t.priority}, $${t.maxBudgetUsd})`;
      if (t.notes) line += ` — ${t.notes}`;
      return line;
    });
    return this.ok(lines.length > 0 ? lines.join('\n') : 'No tasks found.');
  }

  private async tasksCreate(input: Record<string, unknown>): Promise<ToolResult> {
    // Check planned task cap
    if (this.tasks.getPlannedCount() >= this.safety.getConfig().maxPlannedTasks) {
      return this.error(`Cannot create task: planned task limit reached (${this.safety.getConfig().maxPlannedTasks}). Complete or remove existing planned tasks first.`);
    }

    const task = await this.tasks.createTask({
      title: input.title as string,
      description: (input.description as string) || '',
      model: (input.model as ModelChoice) || 'sonnet',
      priority: (input.priority as TaskPriority) || 'medium',
      maxBudgetUsd: (input.maxBudgetUsd as number) || 2.0,
    });

    this.heartbeat.notifyTaskChange();
    return this.ok(`Task created: ${task.id} — ${task.title}`);
  }

  private async tasksUpdate(input: Record<string, unknown>): Promise<ToolResult> {
    const taskId = input.taskId as string;
    const changes: Record<string, unknown> = {};
    if (input.status) changes.status = input.status;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.priority) changes.priority = input.priority;
    if (input.model) changes.model = input.model;

    const task = await this.tasks.updateTask(taskId, changes);
    if (!task) return this.error(`Task not found: ${taskId}`);

    this.heartbeat.notifyTaskChange();
    return this.ok(`Task ${taskId} updated: ${JSON.stringify(changes)}`);
  }

  private async spawnWorker(input: Record<string, unknown>): Promise<ToolResult> {
    const taskId = input.taskId as string;

    // Re-read task status (prevents race with human edits)
    const task = this.tasks.getTask(taskId);
    if (!task) return this.error(`Task not found: ${taskId}`);
    if (task.status !== 'planned') {
      return this.error(`Task ${taskId} is ${task.status}, not planned. Cannot spawn worker.`);
    }

    // Safety check
    const activeCount = this.adapter.getActiveWorkerCount();
    const check = this.safety.canSpawnWorker(activeCount, task);
    if (!check.allowed) {
      return this.error(`Cannot spawn worker: ${check.reason}`);
    }

    // Spawn approval (if enabled)
    if (this.safety.isApprovalRequired()) {
      // Notify dashboard and wait for human response
      if (this.onSpawnApprovalNeeded) {
        this.onSpawnApprovalNeeded(taskId, { title: task.title, model: task.model });
      }
      const approved = await this.safety.requestApproval(task);
      if (!approved) {
        return this.error(`Spawn rejected by human for task ${taskId}.`);
      }
      // Re-check task status after approval wait (human may have changed it)
      const refreshedTask = this.tasks.getTask(taskId);
      if (!refreshedTask || refreshedTask.status !== 'planned') {
        return this.error(`Task ${taskId} status changed during approval wait.`);
      }
    }

    // Create worker directory
    const workerDir = join(this.projectPath, 'workers', taskId);
    const outputDir = join(workerDir, 'output');
    mkdirSync(outputDir, { recursive: true });

    // Write worker SOUL.md
    const soulContent = `# SOUL — Worker for ${task.title}

## Task
${task.title}
${task.description || ''}

## Rules
- Write ALL output to the output/ directory in your working folder
- You have read access to the project folder for context
- You CANNOT use the Bash tool
- You CANNOT write files outside your working directory
- Complete the task, then stop

## Model
${task.model}

## Budget
$${task.maxBudgetUsd}
`;
    writeFileSync(join(workerDir, 'SOUL.md'), soulContent);

    // Model mapping
    const modelMap: Record<string, string> = {
      opus: 'claude-opus-4-6',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
    };

    // Get output callback for worker terminal streaming
    const outputCb = this.onWorkerOutput ? this.onWorkerOutput(taskId) : undefined;

    // Spawn the worker FIRST — only mark active if spawn succeeds
    let session;
    try {
      session = await this.adapter.spawnSession(
        'worker',
        {
          model: modelMap[task.model] || 'claude-sonnet-4-6',
          cwd: workerDir,
          additionalDirectories: [this.projectPath],
          disallowedTools: this.safety.getWorkerDisallowedTools(),
          canUseTool: this.safety.createWorkerToolGuard(workerDir),
          maxBudgetUsd: task.maxBudgetUsd,
          persistSession: false,
        },
        outputCb,
        taskId,
      );
    } catch (err) {
      this.logger.error({ taskId, err }, 'Failed to spawn worker');
      return this.error(`Failed to spawn worker for task ${taskId}: ${err}`);
    }

    // Spawn succeeded — now mark task active
    await this.tasks.updateTask(taskId, {
      status: 'active',
      assignee: session.id,
    });

    if (this.onWorkerSpawned) {
      this.onWorkerSpawned(session.id, taskId);
    }

    // Record worker_spawned metric
    this.metrics?.record('worker_spawned', {
      taskId,
      model: task.model,
      maxBudgetUsd: task.maxBudgetUsd,
    });

    this.heartbeat.notifyTaskChange();
    this.logger.info({ taskId, agentId: session.id, model: task.model }, 'Worker spawned');
    return this.ok(`Worker ${session.id} spawned for task ${taskId} (${task.model})`);
  }

  private workerStatus(input: Record<string, unknown>): ToolResult {
    const agentId = input.agentId as string;
    const info = this.adapter.getSessionInfo(agentId);
    if (!info) return this.error(`Worker not found: ${agentId}`);

    const minutes = Math.floor(info.runtime / 60000);
    const remaining = this.safety.getWorkerRemainingMinutes(new Date(info.startedAt).getTime());
    return this.ok(
      `Worker ${agentId}: ${info.status} | ${minutes}m elapsed | ${remaining}m remaining | $${info.costUsd.toFixed(2)} spent | ${info.tokensInput + info.tokensOutput} tokens`,
    );
  }

  private async killWorker(input: Record<string, unknown>): Promise<ToolResult> {
    const agentId = input.agentId as string;
    const session = this.adapter.getSession(agentId);
    if (!session) return this.error(`Worker not found: ${agentId}`);

    // Capture info before kill
    const info = this.adapter.getSessionInfo(agentId);

    await this.adapter.killSession(agentId);

    // Record metrics
    this.metrics?.record('worker_killed', {
      taskId: session.taskId || 'unknown',
      agentId,
      reason: 'ceo',
    });
    if (info) {
      this.metrics?.record('worker_completed', {
        taskId: session.taskId || 'unknown',
        agentId,
        model: session.config.model,
        durationMinutes: Math.round(info.runtime / 60000),
        tokensInput: info.tokensInput,
        tokensOutput: info.tokensOutput,
        costUsd: info.costUsd,
        success: false,
      });
    }

    // Mark task as failed
    if (session.taskId) {
      await this.tasks.updateTask(session.taskId, {
        status: 'failed',
        notes: 'Killed by CEO',
      });
    }

    this.heartbeat.notifyTaskChange();
    return this.ok(`Worker ${agentId} killed.`);
  }

  private listWorkers(): ToolResult {
    const workers = this.adapter.getActiveSessions('worker');
    if (workers.length === 0) return this.ok('No active workers.');

    const lines = workers.map((w) => {
      const info = this.adapter.getSessionInfo(w.id);
      const minutes = info ? Math.floor(info.runtime / 60000) : 0;
      const cost = info ? `$${info.costUsd.toFixed(2)}` : '$0.00';
      return `${w.id}: task=${w.taskId || 'none'} | ${w.status} | ${minutes}m | ${cost}`;
    });

    return this.ok(lines.join('\n'));
  }

  // ─── Helpers ───

  private ok(text: string): ToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private error(text: string): ToolResult {
    return { content: [{ type: 'text', text }], isError: true };
  }
}
