import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Logger } from 'pino';

// ─── Event Types ───

export interface HeartbeatEvent {
  skipped: boolean;
  intervalMinutes: number;
  tasksChanged: boolean;
  tokensInput?: number;
  tokensOutput?: number;
}

export interface WorkerSpawnedEvent {
  taskId: string;
  model: string;
  maxBudgetUsd: number;
}

export interface WorkerCompletedEvent {
  taskId: string;
  agentId: string;
  model: string;
  durationMinutes: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  success: boolean;
}

export interface WorkerKilledEvent {
  taskId: string;
  agentId: string;
  reason: 'timeout' | 'human' | 'ceo' | 'shutdown';
}

export interface HumanInteractionEvent {
  action: 'prompt' | 'pause' | 'resume' | 'kill_worker' | 'create_task' | 'update_task' | 'approve_spawn' | 'reject_spawn';
}

export interface CostMilestoneEvent {
  dailySpend: number;
  budgetPercent: number;
  milestone: '25%' | '50%' | '80%' | '100%';
}

export interface CeoRestartEvent {
  reason: 'session_age' | 'crash';
  sessionDurationMinutes: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface SessionSummaryEvent {
  date: string;
  totalCostUsd: number;
  tasksCompleted: number;
  tasksFailed: number;
  workersSpawned: number;
  workerSuccessRate: number;
  heartbeatCount: number;
  heartbeatSkipRate: number;
  humanInteractions: number;
  ceoRestarts: number;
  sessionDurationMinutes: number;
}

type MetricEventMap = {
  heartbeat: HeartbeatEvent;
  worker_spawned: WorkerSpawnedEvent;
  worker_completed: WorkerCompletedEvent;
  worker_killed: WorkerKilledEvent;
  human_interaction: HumanInteractionEvent;
  cost_milestone: CostMilestoneEvent;
  ceo_restart: CeoRestartEvent;
  session_summary: SessionSummaryEvent;
};

export type MetricEventType = keyof MetricEventMap;

export interface MetricEntry<T extends MetricEventType = MetricEventType> {
  timestamp: string;
  event: T;
  data: MetricEventMap[T];
}

// ─── MetricsCollector ───

export class MetricsCollector {
  private projectPath: string;
  private logger: Logger;
  private metricsDir: string;
  private startTime: number;
  private crossedMilestones = new Set<string>();

  constructor(projectPath: string, logger: Logger) {
    this.projectPath = projectPath;
    this.logger = logger;
    this.metricsDir = join(projectPath, 'metrics');
    this.startTime = Date.now();

    // Ensure metrics directory exists
    mkdirSync(this.metricsDir, { recursive: true });

    // Rotate old files on startup
    this.rotateFiles();
  }

  // ─── Record ───

  record<T extends MetricEventType>(event: T, data: MetricEventMap[T]): void {
    const entry: MetricEntry<T> = {
      timestamp: new Date().toISOString(),
      event,
      data,
    };

    try {
      const filePath = this.getCurrentFilePath();
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      this.logger.error({ err, event }, 'Failed to write metric');
    }
  }

  // ─── Cost Milestone Check ───

  checkCostMilestone(dailySpend: number, budgetLimit: number): void {
    const percent = (dailySpend / budgetLimit) * 100;
    const milestones: Array<{ threshold: number; label: '25%' | '50%' | '80%' | '100%' }> = [
      { threshold: 25, label: '25%' },
      { threshold: 50, label: '50%' },
      { threshold: 80, label: '80%' },
      { threshold: 100, label: '100%' },
    ];

    for (const { threshold, label } of milestones) {
      if (percent >= threshold && !this.crossedMilestones.has(label)) {
        this.crossedMilestones.add(label);
        this.record('cost_milestone', {
          dailySpend,
          budgetPercent: Math.round(percent * 100) / 100,
          milestone: label,
        });
      }
    }
  }

  // Reset milestones at day boundary (call from daily spend reset)
  resetDailyMilestones(): void {
    this.crossedMilestones.clear();
  }

  // ─── Daily Summary ───

  generateDailySummary(): SessionSummaryEvent {
    const entries = this.readTodayEntries();

    let totalCostUsd = 0;
    let tasksCompleted = 0;
    let tasksFailed = 0;
    let workersSpawned = 0;
    let workerSuccesses = 0;
    let heartbeatCount = 0;
    let heartbeatSkips = 0;
    let humanInteractions = 0;
    let ceoRestarts = 0;

    for (const entry of entries) {
      switch (entry.event) {
        case 'worker_completed': {
          const d = entry.data as WorkerCompletedEvent;
          totalCostUsd += d.costUsd;
          if (d.success) {
            tasksCompleted++;
            workerSuccesses++;
          } else {
            tasksFailed++;
          }
          break;
        }
        case 'worker_spawned':
          workersSpawned++;
          break;
        case 'worker_killed':
          tasksFailed++;
          break;
        case 'heartbeat': {
          heartbeatCount++;
          if ((entry.data as HeartbeatEvent).skipped) heartbeatSkips++;
          break;
        }
        case 'human_interaction':
          humanInteractions++;
          break;
        case 'ceo_restart':
          ceoRestarts++;
          break;
        case 'cost_milestone': {
          // Use the highest cost milestone as a fallback total
          const cm = entry.data as CostMilestoneEvent;
          if (cm.dailySpend > totalCostUsd) totalCostUsd = cm.dailySpend;
          break;
        }
      }
    }

    const workerSuccessRate = workersSpawned > 0
      ? Math.round((workerSuccesses / workersSpawned) * 100)
      : 0;
    const heartbeatSkipRate = heartbeatCount > 0
      ? Math.round((heartbeatSkips / heartbeatCount) * 100)
      : 0;
    const sessionDurationMinutes = Math.round((Date.now() - this.startTime) / 60000);

    const summary: SessionSummaryEvent = {
      date: new Date().toISOString().split('T')[0],
      totalCostUsd: Math.round(totalCostUsd * 100) / 100,
      tasksCompleted,
      tasksFailed,
      workersSpawned,
      workerSuccessRate,
      heartbeatCount,
      heartbeatSkipRate,
      humanInteractions,
      ceoRestarts,
      sessionDurationMinutes,
    };

    // Record the summary as an event too
    this.record('session_summary', summary);

    return summary;
  }

  // ─── Daily Report ───

  generateDailyReport(projectPath: string): string {
    const summary = this.getLatestSummaryOrGenerate();
    const date = summary.date || new Date().toISOString().split('T')[0];

    const report = `# Eunomia Daily Report — ${date}

## Summary

| Metric | Value |
|--------|-------|
| Total Cost | $${summary.totalCostUsd.toFixed(2)} |
| Session Duration | ${summary.sessionDurationMinutes}m |
| Tasks Completed | ${summary.tasksCompleted} |
| Tasks Failed | ${summary.tasksFailed} |
| Workers Spawned | ${summary.workersSpawned} |
| Worker Success Rate | ${summary.workerSuccessRate}% |
| Heartbeats | ${summary.heartbeatCount} |
| Heartbeat Skip Rate | ${summary.heartbeatSkipRate}% |
| Human Interactions | ${summary.humanInteractions} |
| CEO Restarts | ${summary.ceoRestarts} |

## Event Log

${this.formatEventLog()}

---
*Generated by Eunomia at ${new Date().toISOString()}*
`;

    // Write report
    const reportsDir = join(projectPath, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, `${date}.md`);
    writeFileSync(reportPath, report, 'utf-8');
    this.logger.info({ reportPath }, 'Daily report written');

    return report;
  }

  // ─── REST Helpers ───

  getSummaryJson(): SessionSummaryEvent {
    return this.getLatestSummaryOrGenerate();
  }

  getReportMarkdown(projectPath: string): string {
    const date = new Date().toISOString().split('T')[0];
    const reportPath = join(projectPath, 'reports', `${date}.md`);
    if (existsSync(reportPath)) {
      return readFileSync(reportPath, 'utf-8');
    }
    // Generate on-the-fly if not yet written
    return this.generateDailyReport(projectPath);
  }

  // ─── Internal ───

  private getCurrentFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return join(this.metricsDir, `metrics-${date}.jsonl`);
  }

  private readTodayEntries(): MetricEntry[] {
    const filePath = this.getCurrentFilePath();
    if (!existsSync(filePath)) return [];

    try {
      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) return [];

      return content.split('\n').map((line) => {
        try {
          return JSON.parse(line) as MetricEntry;
        } catch {
          return null;
        }
      }).filter((e): e is MetricEntry => e !== null);
    } catch {
      return [];
    }
  }

  private getLatestSummaryOrGenerate(): SessionSummaryEvent {
    // Check if there is already a session_summary for today
    const entries = this.readTodayEntries();
    const summaries = entries.filter((e) => e.event === 'session_summary');
    if (summaries.length > 0) {
      const latest = summaries[summaries.length - 1];
      return latest.data as SessionSummaryEvent;
    }
    // Compute live
    return this.computeLiveSummary(entries);
  }

  private computeLiveSummary(entries: MetricEntry[]): SessionSummaryEvent {
    let totalCostUsd = 0;
    let tasksCompleted = 0;
    let tasksFailed = 0;
    let workersSpawned = 0;
    let workerSuccesses = 0;
    let heartbeatCount = 0;
    let heartbeatSkips = 0;
    let humanInteractions = 0;
    let ceoRestarts = 0;

    for (const entry of entries) {
      switch (entry.event) {
        case 'worker_completed': {
          const d = entry.data as WorkerCompletedEvent;
          totalCostUsd += d.costUsd;
          if (d.success) {
            tasksCompleted++;
            workerSuccesses++;
          } else {
            tasksFailed++;
          }
          break;
        }
        case 'worker_spawned':
          workersSpawned++;
          break;
        case 'worker_killed':
          tasksFailed++;
          break;
        case 'heartbeat': {
          heartbeatCount++;
          if ((entry.data as HeartbeatEvent).skipped) heartbeatSkips++;
          break;
        }
        case 'human_interaction':
          humanInteractions++;
          break;
        case 'ceo_restart':
          ceoRestarts++;
          break;
        case 'cost_milestone': {
          const cm = entry.data as CostMilestoneEvent;
          if (cm.dailySpend > totalCostUsd) totalCostUsd = cm.dailySpend;
          break;
        }
      }
    }

    const workerSuccessRate = workersSpawned > 0
      ? Math.round((workerSuccesses / workersSpawned) * 100)
      : 0;
    const heartbeatSkipRate = heartbeatCount > 0
      ? Math.round((heartbeatSkips / heartbeatCount) * 100)
      : 0;
    const sessionDurationMinutes = Math.round((Date.now() - this.startTime) / 60000);

    return {
      date: new Date().toISOString().split('T')[0],
      totalCostUsd: Math.round(totalCostUsd * 100) / 100,
      tasksCompleted,
      tasksFailed,
      workersSpawned,
      workerSuccessRate,
      heartbeatCount,
      heartbeatSkipRate,
      humanInteractions,
      ceoRestarts,
      sessionDurationMinutes,
    };
  }

  private formatEventLog(): string {
    const entries = this.readTodayEntries();
    if (entries.length === 0) return '_No events recorded._';

    const lines: string[] = [];
    for (const entry of entries) {
      if (entry.event === 'session_summary') continue; // skip summaries in log
      const time = new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false });
      const dataStr = JSON.stringify(entry.data);
      lines.push(`- \`${time}\` **${entry.event}** ${dataStr}`);
    }
    return lines.join('\n');
  }

  // ─── File Rotation ───

  private rotateFiles(): void {
    try {
      if (!existsSync(this.metricsDir)) return;

      const files = readdirSync(this.metricsDir)
        .filter((f) => f.startsWith('metrics-') && f.endsWith('.jsonl'))
        .sort();

      const maxFiles = 30;
      if (files.length > maxFiles) {
        const toRemove = files.slice(0, files.length - maxFiles);
        for (const file of toRemove) {
          try {
            unlinkSync(join(this.metricsDir, file));
            this.logger.info({ file }, 'Rotated old metrics file');
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to rotate metrics files');
    }
  }
}
