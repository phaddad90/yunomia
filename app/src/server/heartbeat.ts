import type { Logger } from 'pino';
import type { SafetyModule } from './safety.js';
import type { TaskManager } from './tasks.js';
import type { AgentAdapter } from './agent-adapter.js';
import type { MetricsCollector } from './metrics.js';

/**
 * Adaptive heartbeat scheduler.
 *
 * States:
 * - ACTIVE: firing at base interval (default 10min)
 * - BACKING_OFF: doubling interval after consecutive no-ops (max 60min)
 * - PAUSED: stopped by safety module (inactivity, budget, working hours)
 * - STOPPED: shutdown
 *
 * Skips if:
 * - No tasks have changed since last heartbeat
 * - Safety module says no (paused, budget, working hours)
 *
 * Resets to base interval on any task state change.
 */

type HeartbeatState = 'active' | 'backing_off' | 'paused' | 'stopped';

const HEARTBEAT_PROMPT = 'Check TASKS.md. If any tasks changed status since your last check, review the output and update accordingly. Otherwise, confirm no action needed.';

export class HeartbeatScheduler {
  private logger: Logger;
  private safety: SafetyModule;
  private tasks: TaskManager;
  private adapter: AgentAdapter;
  private metrics?: MetricsCollector;
  private ceoAgentId: string | null = null;

  private state: HeartbeatState = 'stopped';
  private baseIntervalMs: number;
  private currentIntervalMs: number;
  private maxIntervalMs = 60 * 60 * 1000; // 60 min
  private consecutiveNoOps = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTaskHash = '';
  private lastFireTime = 0;
  private onHeartbeat?: (response: string) => void;

  constructor(
    logger: Logger,
    safety: SafetyModule,
    tasks: TaskManager,
    adapter: AgentAdapter,
    metrics?: MetricsCollector,
  ) {
    this.logger = logger;
    this.safety = safety;
    this.tasks = tasks;
    this.adapter = adapter;
    this.metrics = metrics;
    this.baseIntervalMs = safety.getConfig().heartbeatIntervalMinutes * 60 * 1000;
    this.currentIntervalMs = this.baseIntervalMs;
  }

  setCeoAgentId(id: string): void {
    this.ceoAgentId = id;
  }

  setOnHeartbeat(cb: (response: string) => void): void {
    this.onHeartbeat = cb;
  }

  start(): void {
    if (this.state !== 'stopped') return;
    this.state = 'active';
    this.currentIntervalMs = this.baseIntervalMs;
    this.consecutiveNoOps = 0;
    this.lastTaskHash = this.getTaskHash();
    this.scheduleNext();
    this.logger.info({ intervalMs: this.currentIntervalMs }, 'Heartbeat started');
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('Heartbeat stopped');
  }

  pause(): void {
    if (this.state === 'stopped') return;
    this.state = 'paused';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('Heartbeat paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'active';
    this.currentIntervalMs = this.baseIntervalMs;
    this.consecutiveNoOps = 0;
    this.scheduleNext();
    this.logger.info('Heartbeat resumed');
  }

  // Reset interval to base when tasks change
  notifyTaskChange(): void {
    if (this.state === 'backing_off') {
      this.state = 'active';
      this.currentIntervalMs = this.baseIntervalMs;
      this.consecutiveNoOps = 0;
      // Reschedule with shorter interval
      if (this.timer) {
        clearTimeout(this.timer);
        this.scheduleNext();
      }
      this.logger.info('Heartbeat reset to base interval (task change detected)');
    }
  }

  getState(): {
    state: HeartbeatState;
    intervalMinutes: number;
    consecutiveNoOps: number;
    nextFireIn: number;
    lastFired: number;
  } {
    const nextFireIn = this.timer
      ? Math.max(0, this.currentIntervalMs - (Date.now() - this.lastFireTime))
      : 0;
    return {
      state: this.state,
      intervalMinutes: Math.round(this.currentIntervalMs / 60000),
      consecutiveNoOps: this.consecutiveNoOps,
      nextFireIn: Math.round(nextFireIn / 1000),
      lastFired: this.lastFireTime,
    };
  }

  // ─── Internal ───

  private scheduleNext(): void {
    if (this.state === 'stopped' || this.state === 'paused') return;

    this.timer = setTimeout(() => {
      this.fire();
    }, this.currentIntervalMs);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    this.lastFireTime = Date.now();

    // Safety checks
    if (!this.safety.shouldFireHeartbeat()) {
      this.logger.info('Heartbeat skipped (safety block)');
      this.metrics?.record('heartbeat', { skipped: true, intervalMinutes: Math.round(this.currentIntervalMs / 60000), tasksChanged: false });
      this.pause();
      return;
    }

    // Skip heartbeat if spawn approval is pending (CEO is blocked waiting)
    if (this.safety.hasPendingApprovals()) {
      this.logger.info('Heartbeat skipped (approval pending)');
      this.metrics?.record('heartbeat', { skipped: true, intervalMinutes: Math.round(this.currentIntervalMs / 60000), tasksChanged: false });
      this.scheduleNext();
      return;
    }

    // Check inactivity
    if (this.safety.isInactive()) {
      this.logger.info({ inactiveMinutes: this.safety.getInactivityMinutes() }, 'Heartbeat paused (human inactive)');
      this.metrics?.record('heartbeat', {
        skipped: true,
        intervalMinutes: Math.round(this.currentIntervalMs / 60000),
        tasksChanged: false,
      });
      this.pause();
      return;
    }

    // Check if tasks have changed
    const currentHash = this.getTaskHash();
    const tasksChanged = currentHash !== this.lastTaskHash;
    this.lastTaskHash = currentHash;

    if (!tasksChanged) {
      this.consecutiveNoOps++;
      if (this.consecutiveNoOps >= 3) {
        // Back off: double interval (max 60 min)
        this.state = 'backing_off';
        this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
        this.logger.info({
          consecutiveNoOps: this.consecutiveNoOps,
          newIntervalMin: Math.round(this.currentIntervalMs / 60000),
        }, 'Heartbeat backing off (no task changes)');
      }
    } else {
      this.consecutiveNoOps = 0;
      this.currentIntervalMs = this.baseIntervalMs;
      this.state = 'active';
    }

    // Fire the heartbeat to CEO
    if (this.ceoAgentId) {
      try {
        this.logger.info({ interval: Math.round(this.currentIntervalMs / 60000) }, 'Heartbeat fired');
        await this.adapter.sendMessage(this.ceoAgentId, HEARTBEAT_PROMPT);
      } catch (err) {
        this.logger.error({ err }, 'Heartbeat failed to send to CEO');
      }
    }

    // Record heartbeat metric
    const ceoSession = this.ceoAgentId ? this.adapter.getSession(this.ceoAgentId) : null;
    this.metrics?.record('heartbeat', {
      skipped: false,
      intervalMinutes: Math.round(this.currentIntervalMs / 60000),
      tasksChanged,
      tokensInput: ceoSession?.info.tokensInput,
      tokensOutput: ceoSession?.info.tokensOutput,
    });

    // Schedule next
    this.scheduleNext();
  }

  private getTaskHash(): string {
    const counts = this.tasks.getStatusCounts();
    return `${counts.planned}-${counts.active}-${counts.done}-${counts.failed}`;
  }
}
