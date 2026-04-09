import { randomUUID } from 'crypto';
import type { SessionConfig, AgentSession, SessionInfo, AgentRole } from './types.js';
import type { Logger } from 'pino';

/**
 * AgentAdapter — thin wrapper around Claude Agent SDK.
 *
 * Uses query() with streaming input mode: an async generator as the prompt
 * yields SDKUserMessage objects to keep the session alive for multi-turn.
 *
 * If the SDK V2 API changes, only this file needs updating.
 * Fallback: reimplement against the CLI with node-pty.
 */

// SDK types we need
interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
}

// SDK import — dynamic to handle missing dependency gracefully
let sdkAvailable = false;
let queryFn: ((_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>) | null = null;
let createSdkMcpServerFn: ((_options: { name: string; tools?: unknown[] }) => unknown) | null = null;
let toolFn: ((...args: unknown[]) => unknown) | null = null;

async function loadSdk(): Promise<boolean> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query as typeof queryFn;
    createSdkMcpServerFn = sdk.createSdkMcpServer as typeof createSdkMcpServerFn;
    toolFn = sdk.tool as typeof toolFn;
    sdkAvailable = true;
    return true;
  } catch {
    return false;
  }
}

// Model name mapping
function resolveModelId(model: string): string {
  const map: Record<string, string> = {
    'opus': 'claude-opus-4-6',
    'sonnet': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
  };
  return map[model] || model;
}

export function getCreateSdkMcpServerFn() { return createSdkMcpServerFn; }
export function getToolFn() { return toolFn; }

export class AgentAdapter {
  private sessions = new Map<string, AgentSession>();
  private messageResolvers = new Map<string, () => void>();
  private messageQueues = new Map<string, Array<{ message: string; resolve: () => void }>>();
  private outputCallbacks = new Map<string, (data: string) => void>();
  private queryHandles = new Map<string, { close: () => void }>();
  private logger: Logger;
  private sdkLoaded = false;
  private onCostUpdate?: (agentId: string, costUsd: number, tokensInput: number, tokensOutput: number) => void;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async init(): Promise<void> {
    this.sdkLoaded = await loadSdk();
    if (this.sdkLoaded) {
      this.logger.info('Claude Agent SDK loaded successfully');
    } else {
      this.logger.warn('Claude Agent SDK not available — running in demo mode');
    }
  }

  isAvailable(): boolean {
    return this.sdkLoaded;
  }

  setOnCostUpdate(cb: (agentId: string, costUsd: number, tokensInput: number, tokensOutput: number) => void): void {
    this.onCostUpdate = cb;
  }

  // ─── Spawn ───

  async spawnSession(
    role: AgentRole,
    config: SessionConfig,
    onOutput?: (data: string) => void,
    taskId?: string,
  ): Promise<AgentSession> {
    const id = `${role}-${randomUUID().slice(0, 8)}`;
    const sessionId = randomUUID();

    const session: AgentSession = {
      id,
      role,
      taskId,
      config,
      status: 'starting',
      sessionId,
      process: null,
      info: {
        sessionId,
        status: 'starting',
        model: config.model,
        tokensInput: 0,
        tokensOutput: 0,
        costUsd: 0,
        startedAt: new Date().toISOString(),
        runtime: 0,
      },
    };

    this.sessions.set(id, session);
    if (onOutput) {
      this.outputCallbacks.set(id, onOutput);
    }

    if (!this.sdkLoaded) {
      session.status = 'running';
      session.info.status = 'running';
      if (onOutput) {
        onOutput(`[Eunomia] Agent ${id} started in demo mode (SDK not available)\r\n`);
        onOutput(`[Eunomia] Model: ${config.model} | CWD: ${config.cwd}\r\n`);
        onOutput(`[Eunomia] To enable real agents, install @anthropic-ai/claude-agent-sdk\r\n\r\n`);
      }
      this.logger.info({ agentId: id, role, model: config.model }, 'Agent spawned (demo mode)');
      return session;
    }

    // Real SDK session
    session.status = 'running';
    session.info.status = 'running';
    this.runSdkSession(session, config, onOutput).catch((err) => {
      if (session.status === 'running') {
        session.status = 'crashed';
        session.info.status = 'crashed';
        this.logger.error({ agentId: id, err }, 'Agent session crashed (unhandled)');
        if (onOutput) onOutput(`\r\n[Eunomia] Agent crashed: ${err}\r\n`);
      }
    });
    this.logger.info({ agentId: id, role, model: config.model, cwd: config.cwd }, 'Agent spawned');

    return session;
  }

  private async runSdkSession(
    session: AgentSession,
    config: SessionConfig,
    onOutput?: (data: string) => void,
  ): Promise<void> {
    if (!queryFn) return;

    const messageQueue: Array<{ message: string; resolve: () => void }> = [];
    this.messageQueues.set(session.id, messageQueue);

    // Build the async generator that yields messages as they arrive
    const self = this;
    const sessionRef = session;

    async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
      // First message — cold-start prompt
      const coldStartPrompt = sessionRef.role === 'ceo'
        ? 'Read your SOUL.md and GOALS.md for your role and targets. Then read TASKS.md to check the current task board. If PROJECT.md has placeholder text, ask the human to fill it in.'
        : 'Read your SOUL.md for your task assignment. Complete the task and write all output to the output/ directory.';

      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: coldStartPrompt },
        parent_tool_use_id: null,
      };

      // Subsequent messages — wait via Promise resolution instead of polling
      while (sessionRef.status === 'running') {
        if (messageQueue.length > 0) {
          const { message, resolve } = messageQueue.shift()!;
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: message },
            parent_tool_use_id: null,
          };
          resolve();
        } else {
          // Wait for a signal that a message has been enqueued or session stopped
          await new Promise<void>((resolve) => {
            self.messageResolvers.set(sessionRef.id, resolve);
          });
        }
      }
    }

    try {
      const options: Record<string, unknown> = {
        model: resolveModelId(config.model),
        cwd: config.cwd,
        additionalDirectories: config.additionalDirectories,
        permissionMode: config.permissionMode || 'auto',
        persistSession: config.persistSession,
        includePartialMessages: true,
      };

      // Only set bypassPermissions for CEO, not workers
      if (config.permissionMode === 'bypassPermissions') {
        options.allowDangerouslySkipPermissions = true;
      }

      if (config.disallowedTools?.length) {
        options.disallowedTools = config.disallowedTools;
      }
      if (config.allowedTools?.length) {
        options.allowedTools = config.allowedTools;
      }
      if (config.maxBudgetUsd) {
        options.maxBudgetUsd = config.maxBudgetUsd;
      }
      if (config.maxTurns) {
        options.maxTurns = config.maxTurns;
      }
      if (config.mcpServers) {
        options.mcpServers = config.mcpServers;
      }
      if (config.canUseTool) {
        options.canUseTool = config.canUseTool;
      }

      const queryResult = queryFn({
        prompt: generateMessages(),
        options,
      });

      // Store query handle for cleanup
      const queryObj = queryResult as unknown as Record<string, unknown>;
      if (queryObj && typeof queryObj.close === 'function') {
        this.queryHandles.set(session.id, queryObj as unknown as { close: () => void });
      }

      for await (const message of queryResult) {
        this.handleSdkMessage(session, message, onOutput);
      }

      // Natural completion — clean up the session
      if (session.status === 'running') {
        session.status = 'stopped';
        session.info.status = 'stopped';
        session.info.runtime = Date.now() - new Date(session.info.startedAt).getTime();
        if (onOutput) onOutput(`\r\n[Eunomia] Agent ${session.id} completed.\r\n`);
        this.logger.info({ agentId: session.id, role: session.role }, 'Agent completed naturally');
        this.outputCallbacks.delete(session.id);
        this.messageQueues.delete(session.id);
        this.messageResolvers.delete(session.id);
        this.queryHandles.delete(session.id);
        this.sessions.delete(session.id);
      }
    } catch (err) {
      if (session.status === 'running') {
        session.status = 'crashed';
        session.info.status = 'crashed';
        session.info.runtime = Date.now() - new Date(session.info.startedAt).getTime();
        this.logger.error({ agentId: session.id, err }, 'Agent session crashed');
        if (onOutput) onOutput(`\r\n[Eunomia] Agent crashed: ${err}\r\n`);
        // Clean up crashed sessions too
        this.outputCallbacks.delete(session.id);
        this.messageQueues.delete(session.id);
        this.messageResolvers.delete(session.id);
        this.queryHandles.delete(session.id);
        this.sessions.delete(session.id);
      }
    }
  }

  private handleSdkMessage(
    session: AgentSession,
    message: Record<string, unknown>,
    onOutput?: (data: string) => void,
  ): void {
    const type = message.type as string;

    if (type === 'stream_event') {
      const event = message.event as Record<string, unknown>;
      if (event?.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>;
        if (delta?.type === 'text_delta' && delta.text) {
          if (onOutput) onOutput(delta.text as string);
        }
      }
    }

    if (type === 'assistant') {
      const content = message.content as string;
      if (content && onOutput) {
        onOutput(content + '\r\n');
      }
    }

    if (type === 'result') {
      if (message.total_cost_usd !== undefined) {
        const newCost = message.total_cost_usd as number;
        session.info.costUsd = newCost;
      }
      if (message.usage) {
        const usage = message.usage as Record<string, number>;
        session.info.tokensInput = usage.input_tokens || 0;
        session.info.tokensOutput = usage.output_tokens || 0;
      }
      session.info.runtime = Date.now() - new Date(session.info.startedAt).getTime();

      // Notify cost tracker
      if (this.onCostUpdate) {
        this.onCostUpdate(session.id, session.info.costUsd, session.info.tokensInput, session.info.tokensOutput);
      }
    }
  }

  // ─── Message Sending ───

  async sendMessage(agentId: string, message: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session || session.status !== 'running') {
      throw new Error(`Agent ${agentId} is not running`);
    }

    if (!this.sdkLoaded) {
      const cb = this.outputCallbacks.get(agentId);
      if (cb) {
        cb(`\r\n> ${message}\r\n`);
        cb(`[Demo] Received message. SDK not available for real processing.\r\n\r\n`);
      }
      return;
    }

    const queue = this.messageQueues.get(agentId);
    if (!queue) throw new Error(`No message queue for agent ${agentId}`);

    return new Promise((resolve) => {
      queue.push({ message, resolve });
      // Wake the generator
      const wakeResolver = this.messageResolvers.get(agentId);
      if (wakeResolver) {
        this.messageResolvers.delete(agentId);
        wakeResolver();
      }
    });
  }

  // ─── Kill ───

  async killSession(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;

    session.status = 'stopped';
    session.info.status = 'stopped';
    session.info.runtime = Date.now() - new Date(session.info.startedAt).getTime();

    // Close the SDK query handle
    const handle = this.queryHandles.get(agentId);
    if (handle) {
      try { handle.close(); } catch { /* ignore */ }
      this.queryHandles.delete(agentId);
    }

    // Wake the generator so it exits the while loop
    const wakeResolver = this.messageResolvers.get(agentId);
    if (wakeResolver) {
      this.messageResolvers.delete(agentId);
      wakeResolver();
    }

    const cb = this.outputCallbacks.get(agentId);
    if (cb) {
      cb(`\r\n[Eunomia] Agent ${agentId} stopped.\r\n`);
    }

    // Cleanup
    this.outputCallbacks.delete(agentId);
    this.messageQueues.delete(agentId);
    this.sessions.delete(agentId);
    this.logger.info({ agentId }, 'Agent killed');
  }

  // ─── Output ───

  setOutputCallback(agentId: string, cb: (data: string) => void): void {
    this.outputCallbacks.set(agentId, cb);
  }

  // ─── Info ───

  getSession(agentId: string): AgentSession | undefined {
    return this.sessions.get(agentId);
  }

  getSessionInfo(agentId: string): SessionInfo | undefined {
    const session = this.sessions.get(agentId);
    if (!session) return undefined;
    session.info.runtime = Date.now() - new Date(session.info.startedAt).getTime();
    return { ...session.info };
  }

  getActiveSessions(role?: AgentRole): AgentSession[] {
    const all = Array.from(this.sessions.values());
    const active = all.filter((s) => s.status === 'running' || s.status === 'starting');
    return role ? active.filter((s) => s.role === role) : active;
  }

  getActiveWorkerCount(): number {
    return this.getActiveSessions('worker').length;
  }

  getCeoSession(): AgentSession | undefined {
    return Array.from(this.sessions.values()).find(
      (s) => s.role === 'ceo' && (s.status === 'running' || s.status === 'starting'),
    );
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  // ─── Cleanup ───

  async killAllWorkers(): Promise<void> {
    const workers = this.getActiveSessions('worker');
    for (const worker of workers) {
      await this.killSession(worker.id);
    }
  }

  async shutdown(): Promise<void> {
    for (const [, session] of this.sessions) {
      if (session.status === 'running' || session.status === 'starting') {
        await this.killSession(session.id);
      }
    }
  }
}
