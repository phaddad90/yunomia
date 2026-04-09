import { resolve } from 'path';
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

  constructor(config: SafetyConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  getConfig(): SafetyConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<SafetyConfig>): void {
    Object.assign(this.config, partial);
    this.logger.info({ config: partial }, 'Safety config updated');
  }

  // ─── Budget ───

  recordSpend(usd: number): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.dailySpendDate) {
      this.dailySpend = 0;
      this.dailySpendDate = today;
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

  // ─── Worker Write Scope ───

  createWorkerToolGuard(workerDir: string): (tool: string, input: Record<string, unknown>) => { allowed: boolean; reason?: string } {
    const resolvedWorkerDir = resolve(workerDir);

    return (tool: string, input: Record<string, unknown>) => {
      const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    if (WRITE_TOOLS.has(tool)) {
        const targetPath = input.file_path as string;
        if (targetPath && !resolve(targetPath).startsWith(resolvedWorkerDir)) {
          this.logger.warn({ tool, targetPath, workerDir: resolvedWorkerDir }, 'Worker write blocked — outside scope');
          return { allowed: false, reason: 'Workers can only write to their output directory' };
        }
      }
      return { allowed: true };
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
      // Don't auto-unpause — human must explicitly resume
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
    // Simple hour check — timezone handling is approximate for V1
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
    });
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

  isWorkerTimedOut(startTime: number): boolean {
    const elapsed = Date.now() - startTime;
    return elapsed > this.config.maxWorkerRuntimeMinutes * 60 * 1000;
  }

  getWorkerRemainingMinutes(startTime: number): number {
    const elapsed = Date.now() - startTime;
    const maxMs = this.config.maxWorkerRuntimeMinutes * 60 * 1000;
    return Math.max(0, Math.floor((maxMs - elapsed) / 60000));
  }
}
