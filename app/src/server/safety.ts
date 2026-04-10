import { resolve, sep, join } from 'path';
import type { SafetyConfig, AgentSession, Task } from './types.js';
import type { Logger } from 'pino';

export class SafetyModule {
  private config: SafetyConfig;
  private logger: Logger;
  private dailySpend = 0;
  private dailySpendDate = new Date().toISOString().split('T')[0];
  private lastHumanInteraction = Date.now();
  private paused = false;
  private pendingApprovals = new Map<string, { task: Task; resolve: (approved: boolean) => void }>();
  private onDayReset?: () => void;

  constructor(config: SafetyConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  setOnDayReset(cb: () => void): void {
    this.onDayReset = cb;
  }

  getConfig(): SafetyConfig {
    return { ...this.config };
  }

  updateConfig(partial: Record<string, unknown>): void {
    // Whitelist + validate each field
    const validators: Record<string, (v: unknown) => boolean> = {
      maxConcurrentWorkers: (v) => typeof v === 'number' && v >= 1 && v <= 10,
      maxDailyBudgetUsd: (v) => typeof v === 'number' && v >= 1 && v <= 500,
      maxWorkerRuntimeMinutes: (v) => typeof v === 'number' && v >= 1 && v <= 120,
      maxRetries: (v) => typeof v === 'number' && v >= 0 && v <= 10,
      inactivityPauseMinutes: (v) => typeof v === 'number' && v >= 5 && v <= 480,
      heartbeatIntervalMinutes: (v) => typeof v === 'number' && v >= 1 && v <= 60,
      maxCeoSessionHours: (v) => typeof v === 'number' && v >= 1 && v <= 24,
      maxPlannedTasks: (v) => typeof v === 'number' && v >= 5 && v <= 100,
      stallNudgeMinutes: (v) => typeof v === 'number' && v >= 1 && v <= 10,
      stallKillMinutes: (v) => typeof v === 'number' && v >= 2 && v <= 15,
      hardTimeoutMinutes: (v) => typeof v === 'number' && v >= 5 && v <= 120,
      requireApprovalForSpawn: (v) => typeof v === 'boolean',
    };

    const applied: Record<string, unknown> = {};
    for (const [key, validate] of Object.entries(validators)) {
      if (key in partial && validate(partial[key])) {
        (this.config as unknown as Record<string, unknown>)[key] = partial[key];
        applied[key] = partial[key];
      }
    }

    if (Object.keys(applied).length > 0) {
      this.logger.info({ config: applied }, 'Safety config updated');
    }
  }

  // ─── Budget ───

  recordSpend(usd: number): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.dailySpendDate) {
      this.dailySpend = 0;
      this.dailySpendDate = today;
      if (this.onDayReset) this.onDayReset();
    }
    this.dailySpend += usd;

    if (this.dailySpend >= this.config.maxDailyBudgetUsd) {
      this.logger.warn({ spent: this.dailySpend, limit: this.config.maxDailyBudgetUsd }, 'Daily budget exhausted');
    } else if (this.dailySpend >= this.config.maxDailyBudgetUsd * 0.8) {
      this.logger.warn({ spent: this.dailySpend, limit: this.config.maxDailyBudgetUsd }, 'Daily budget at 80%');
    }
  }

  getDailySpend(): number {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.dailySpendDate) {
      this.dailySpend = 0;
      this.dailySpendDate = today;
    }
    return this.dailySpend;
  }

  getBudgetPercent(): number {
    return (this.getDailySpend() / this.config.maxDailyBudgetUsd) * 100;
  }

  isBudgetExhausted(): boolean {
    return this.getDailySpend() >= this.config.maxDailyBudgetUsd;
  }

  isBudgetWarning(): boolean {
    return this.getBudgetPercent() >= 80;
  }

  // ─── Concurrency ───

  canSpawnWorker(activeWorkers: number, task: Task): { allowed: boolean; reason?: string } {
    if (this.paused) {
      return { allowed: false, reason: 'System is paused' };
    }

    if (this.isBudgetExhausted()) {
      return { allowed: false, reason: `Daily budget exhausted ($${this.dailySpend.toFixed(2)} / $${this.config.maxDailyBudgetUsd})` };
    }

    if (activeWorkers >= this.config.maxConcurrentWorkers) {
      return { allowed: false, reason: `Max concurrent workers reached (${activeWorkers}/${this.config.maxConcurrentWorkers})` };
    }

    if (task.retryCount >= this.config.maxRetries) {
      return { allowed: false, reason: `Task ${task.id} has reached retry limit (${task.retryCount}/${this.config.maxRetries}). Needs human intervention.` };
    }

    if (!this.isWithinWorkingHours()) {
      return { allowed: false, reason: 'Outside working hours' };
    }

    return { allowed: true };
  }

  // ─── Write Scope Guards ───

  // SDK CanUseTool signature: (toolName, input, options) => Promise<{ behavior: 'allow'|'deny'|'ask' }>
  createWorkerToolGuard(workerDir: string): (tool: string, input: Record<string, unknown>, options?: unknown) => Promise<{ behavior: string }> {
    const resolvedWorkerDir = resolve(workerDir) + sep;

    return async (tool: string, input: Record<string, unknown>) => {
      const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
      if (WRITE_TOOLS.has(tool)) {
        const targetPath = input.file_path as string;
        if (targetPath) {
          const resolvedTarget = resolve(targetPath);
          const inside = resolvedTarget.startsWith(resolvedWorkerDir) || resolvedTarget === resolve(workerDir);
          if (!inside) {
            this.logger.warn({ tool, targetPath, workerDir: resolvedWorkerDir }, 'Worker write blocked - outside scope');
            return { behavior: 'deny' };
          }
        }
      }
      return { behavior: 'allow' };
    };
  }

  // CEO guard: prevent modification of its own SOUL.md and GOALS.md
  createCeoToolGuard(ceoDir: string): (tool: string, input: Record<string, unknown>, options?: unknown) => Promise<{ behavior: string }> {
    const projectRoot = resolve(join(ceoDir, '..'));
    const protectedFiles = [
      resolve(join(ceoDir, 'SOUL.md')),
      resolve(join(ceoDir, 'GOALS.md')),
      resolve(join(projectRoot, 'PROJECT.md')),
      resolve(join(projectRoot, 'TASKS.md')),
    ];

    return async (tool: string, input: Record<string, unknown>) => {
      const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
      if (WRITE_TOOLS.has(tool)) {
        const targetPath = input.file_path as string;
        if (!targetPath) return { behavior: 'allow' };

        const resolvedTarget = resolve(targetPath);

        // Block protected files
        if (protectedFiles.includes(resolvedTarget)) {
          this.logger.warn({ tool, targetPath }, 'CEO write blocked - protected file');
          return { behavior: 'deny' };
        }

        // Size guard on MEMORY.md - block single writes over 100 lines / 4KB
        const memoryFile = resolve(join(ceoDir, 'MEMORY.md'));
        if (resolvedTarget === memoryFile) {
          const content = (input.content as string) || (input.new_string as string) || '';
          if (content.length > 4000 || content.split('\n').length > 100) {
            this.logger.warn({ tool, bytes: content.length }, 'CEO MEMORY.md write blocked - too large');
            return { behavior: 'deny' };
          }
        }
      }
      return { behavior: 'allow' };
    };
  }

  getWorkerDisallowedTools(): string[] {
    return ['Bash'];
  }

  // ─── Heartbeat ───

  shouldFireHeartbeat(): boolean {
    if (this.paused) return false;
    if (this.isBudgetExhausted()) return false;
    if (!this.isWithinWorkingHours()) return false;
    return true;
  }

  // ─── Human Activity ───

  recordHumanInteraction(): void {
    this.lastHumanInteraction = Date.now();
    if (this.paused) {
      // Don't auto-unpause - human must explicitly resume
    }
  }

  isInactive(): boolean {
    const elapsed = Date.now() - this.lastHumanInteraction;
    return elapsed > this.config.inactivityPauseMinutes * 60 * 1000;
  }

  getInactivityMinutes(): number {
    return Math.floor((Date.now() - this.lastHumanInteraction) / 60000);
  }

  // ─── Working Hours ───

  isWithinWorkingHours(): boolean {
    if (!this.config.workingHours) return true;

    const { start, end } = this.config.workingHours;
    const now = new Date();
    // Simple hour check - timezone handling is approximate for V1
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentTime = hour * 60 + minute;

    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;

    return currentTime >= startTime && currentTime <= endTime;
  }

  // ─── CEO Session Age ───

  shouldRestartCeo(sessionStartTime: number): boolean {
    const elapsed = Date.now() - sessionStartTime;
    const maxMs = this.config.maxCeoSessionHours * 60 * 60 * 1000;
    return elapsed >= maxMs;
  }

  getCeoSessionAgePercent(sessionStartTime: number): number {
    const elapsed = Date.now() - sessionStartTime;
    const maxMs = this.config.maxCeoSessionHours * 60 * 60 * 1000;
    return (elapsed / maxMs) * 100;
  }

  // ─── Pause / Resume ───

  isPaused(): boolean {
    return this.paused;
  }

  pause(reason: string): void {
    this.paused = true;
    this.logger.info({ reason }, 'System paused');
  }

  resume(): void {
    this.paused = false;
    this.lastHumanInteraction = Date.now();
    this.logger.info('System resumed');
  }

  // ─── Spawn Approval ───

  isApprovalRequired(): boolean {
    return this.config.requireApprovalForSpawn;
  }

  requestApproval(task: Task): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(task.id, { task, resolve });
      this.logger.info({ taskId: task.id, title: task.title }, 'Spawn approval requested');

      // 10-minute timeout - auto-reject if no response
      setTimeout(() => {
        if (this.pendingApprovals.has(task.id)) {
          this.pendingApprovals.delete(task.id);
          this.logger.warn({ taskId: task.id }, 'Spawn approval timed out - auto-rejected');
          resolve(false);
        }
      }, 10 * 60 * 1000);
    });
  }

  hasPendingApprovals(): boolean {
    return this.pendingApprovals.size > 0;
  }

  resolveApproval(taskId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(taskId);
    if (pending) {
      pending.resolve(approved);
      this.pendingApprovals.delete(taskId);
      this.logger.info({ taskId, approved }, 'Spawn approval resolved');
    }
  }

  getPendingApprovals(): Array<{ taskId: string; task: Task }> {
    return Array.from(this.pendingApprovals.entries()).map(([taskId, { task }]) => ({ taskId, task }));
  }

  // ─── Worker Timeout Check ───

  isWorkerTimedOut(startTime: number, perTaskMinutes?: number): boolean {
    const elapsed = Date.now() - startTime;
    const maxMinutes = perTaskMinutes || this.config.maxWorkerRuntimeMinutes;
    return elapsed > maxMinutes * 60 * 1000;
  }

  getWorkerRemainingMinutes(startTime: number, perTaskMinutes?: number): number {
    const elapsed = Date.now() - startTime;
    const maxMs = (perTaskMinutes || this.config.maxWorkerRuntimeMinutes) * 60 * 1000;
    return Math.max(0, Math.floor((maxMs - elapsed) / 60000));
  }
}
