import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, watchFile, unwatchFile, appendFileSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import type { Task, TaskStatus, TaskPriority, ModelChoice, AuditEntry, TasksState } from './types.js';
import type { Logger } from 'pino';

export class TaskManager {
  private tasks: Task[] = [];
  private filePath: string;
  private auditPath: string;
  private logger: Logger;
  private lastWriteTime = 0;
  private mutexPromise: Promise<void> = Promise.resolve();

  constructor(projectPath: string, logger: Logger) {
    this.filePath = join(projectPath, 'TASKS.md');
    this.auditPath = join(projectPath, 'audit.jsonl');
    this.logger = logger;
    this.load();
    this.startFileWatch();
  }

  // ─── Serialisation ───
  // All mutations go through this queue to prevent concurrent read-modify-write.
  // Each operation acquires the lock, runs fn(), flushes to disk, then releases.

  private async serialise<T>(fn: () => T): Promise<T> {
    let release: () => void;
    const acquired = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.mutexPromise;
    this.mutexPromise = acquired;

    await previous; // wait for previous operation to finish

    try {
      const result = fn();
      this.flush();
      return result;
    } finally {
      release!();
    }
  }

  // ─── File I/O ───

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.tasks = [];
      this.flush();
      return;
    }
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      this.tasks = this.parseTasksMd(content);
      this.logger.info({ count: this.tasks.length }, 'Tasks loaded from TASKS.md');
    } catch (err) {
      this.logger.error({ err }, 'Failed to parse TASKS.md — starting with empty task list');
      this.tasks = [];
    }
  }

  private flush(): void {
    const content = this.renderTasksMd();
    const tmpPath = this.filePath + '.tmp';
    const bakPath = this.filePath + '.bak';

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmpPath, content, 'utf-8');
      if (existsSync(this.filePath)) {
        copyFileSync(this.filePath, bakPath);
      }
      renameSync(tmpPath, this.filePath);
      this.lastWriteTime = Date.now();
    } catch (err) {
      this.logger.error({ err }, 'Failed to flush TASKS.md');
    }
  }

  private startFileWatch(): void {
    watchFile(this.filePath, { interval: 2000 }, (curr, prev) => {
      // Reload if externally modified (not by our own writes)
      if (curr.mtimeMs > prev.mtimeMs && curr.mtimeMs > this.lastWriteTime + 2000) {
        this.logger.info('TASKS.md modified externally — reloading');
        // Reload through the mutex to prevent mid-write clobber
        this.serialise(() => {
          const content = readFileSync(this.filePath, 'utf-8');
          this.tasks = this.parseTasksMd(content);
        });
      }
    });
  }

  destroy(): void {
    unwatchFile(this.filePath);
  }

  // ─── Parsing ───

  private parseTasksMd(content: string): Task[] {
    const tasks: Task[] = [];
    const lines = content.split('\n');
    let currentStatus: TaskStatus = 'planned';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '## Planned') { currentStatus = 'planned'; continue; }
      if (trimmed === '## Active') { currentStatus = 'active'; continue; }
      if (trimmed === '## Done') { currentStatus = 'done'; continue; }
      if (trimmed === '## Failed') { currentStatus = 'failed'; continue; }
      if (trimmed === '## Pulled') { currentStatus = 'pulled'; continue; }

      // Task lines: - [x] `task-001` Title [model] [priority] [$budget] — notes
      const taskMatch = trimmed.match(/^- \[(.)\] `([^`]+)` (.+)$/);
      if (!taskMatch) continue;

      const [, , id, rest] = taskMatch;

      // Extract metadata from BEFORE the notes separator
      const notesSepIdx = rest.search(/\s+[—–-]\s+/);
      const metaPart = notesSepIdx > 0 ? rest.substring(0, notesSepIdx) : rest;
      const notesPart = notesSepIdx > 0 ? rest.substring(notesSepIdx).replace(/^\s+[—–-]\s+/, '') : '';

      const modelMatch = metaPart.match(/\[(opus|sonnet|haiku)\]/i);
      const priorityMatch = metaPart.match(/\[(low|medium|high|critical)\]/i);
      const budgetMatch = metaPart.match(/\[\$([0-9.]+)\]/);
      const actualCostMatch = metaPart.match(/\[\$([0-9.]+) actual\]/);

      // Title is everything before the first bracket in the meta part
      const titleEnd = metaPart.search(/\s*\[/);
      const title = titleEnd > 0 ? metaPart.substring(0, titleEnd).trim() : metaPart.trim();

      const task: Task = {
        id,
        title,
        description: '',
        assignee: null,
        status: currentStatus,
        priority: (priorityMatch?.[1]?.toLowerCase() as TaskPriority) || 'medium',
        model: (modelMatch?.[1]?.toLowerCase() as ModelChoice) || 'sonnet',
        maxBudgetUsd: budgetMatch ? parseFloat(budgetMatch[1]) : 2.0,
        retryCount: 0,
        maxRetries: 2,
        tags: [],
        created: new Date().toISOString(),
        completed: currentStatus === 'done' ? new Date().toISOString() : null,
        tokenCost: {
          input: 0,
          output: 0,
          totalUsd: actualCostMatch ? parseFloat(actualCostMatch[1]) : 0,
        },
        notes: notesPart,
      };

      const retryMatch = task.notes.match(/Retry limit reached \((\d+)\/(\d+)\)/);
      if (retryMatch) {
        task.retryCount = parseInt(retryMatch[1]);
        task.maxRetries = parseInt(retryMatch[2]);
      }

      tasks.push(task);
    }

    return tasks;
  }

  private renderTasksMd(): string {
    const sections: Record<TaskStatus, Task[]> = { planned: [], active: [], done: [], failed: [], pulled: [] };
    for (const task of this.tasks) {
      sections[task.status].push(task);
    }

    let md = '# Tasks\n';

    for (const [status, label] of [
      ['planned', 'Planned'],
      ['active', 'Active'],
      ['done', 'Done'],
      ['failed', 'Failed'],
      ['pulled', 'Pulled'],
    ] as const) {
      md += `\n## ${label}\n\n`;
      const statusTasks = sections[status];
      if (statusTasks.length === 0) {
        md += '_No tasks_\n';
      } else {
        for (const t of statusTasks) {
          const marker = status === 'done' ? 'x' : status === 'active' ? '~' : status === 'failed' ? '!' : status === 'pulled' ? '-' : ' ';
          let line = `- [${marker}] \`${t.id}\` ${t.title} [${t.model}] [${t.priority}] [$${t.maxBudgetUsd.toFixed(2)}]`;
          if (status === 'done' && t.tokenCost.totalUsd > 0) {
            line += ` [$${t.tokenCost.totalUsd.toFixed(2)} actual]`;
          }
          if (t.notes) {
            line += ` — ${t.notes}`;
          }
          md += line + '\n';
        }
      }
    }

    return md;
  }

  // ─── CRUD Operations ───

  async createTask(params: {
    title: string;
    description?: string;
    model?: ModelChoice;
    priority?: TaskPriority;
    maxBudgetUsd?: number;
    tags?: string[];
    parentGoal?: string;
  }): Promise<Task> {
    return this.serialise(() => {
      const id = `task-${String(this.nextId()).padStart(3, '0')}`;
      const task: Task = {
        id,
        title: params.title,
        description: params.description || '',
        assignee: null,
        status: 'planned',
        priority: params.priority || 'medium',
        model: params.model || 'sonnet',
        maxBudgetUsd: params.maxBudgetUsd || 2.0,
        retryCount: 0,
        maxRetries: 2,
        tags: params.tags || [],
        created: new Date().toISOString(),
        completed: null,
        tokenCost: { input: 0, output: 0, totalUsd: 0 },
        notes: '',
        parentGoal: params.parentGoal,
      };
      this.tasks.push(task);
      this.audit('ceo', 'create_task', task.id, `Created: ${task.title}`);
      this.logger.info({ taskId: task.id, title: task.title }, 'Task created');
      return task;
    });
  }

  async updateTask(id: string, changes: Partial<Pick<Task, 'status' | 'notes' | 'priority' | 'model' | 'maxBudgetUsd' | 'tokenCost' | 'assignee' | 'retryCount'>>): Promise<Task | null> {
    return this.serialise(() => {
      const task = this.tasks.find((t) => t.id === id);
      if (!task) return null;

      const before = task.status;
      Object.assign(task, changes);

      if (changes.status === 'done' && !task.completed) {
        task.completed = new Date().toISOString();
      }

      const actor = changes.assignee !== undefined ? 'system' : 'ceo';
      this.audit(actor as 'ceo' | 'system', 'update_task', id, `${before} → ${task.status}: ${task.title}`);
      this.logger.info({ taskId: id, changes }, 'Task updated');
      return task;
    });
  }

  getTask(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  listTasks(filter?: { status?: TaskStatus; assignee?: string; tag?: string }): Task[] {
    let result = [...this.tasks];
    if (filter?.status) result = result.filter((t) => t.status === filter.status);
    if (filter?.assignee) result = result.filter((t) => t.assignee === filter.assignee);
    if (filter?.tag) result = result.filter((t) => t.tags.includes(filter.tag!));
    return result;
  }

  getTasksContent(): string {
    return this.renderTasksMd();
  }

  getState(): TasksState {
    return { tasks: [...this.tasks], lastModified: new Date().toISOString() };
  }

  getStatusCounts(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = { planned: 0, active: 0, done: 0, failed: 0, pulled: 0 };
    for (const t of this.tasks) counts[t.status]++;
    return counts;
  }

  getPlannedCount(): number {
    return this.tasks.filter((t) => t.status === 'planned').length;
  }

  // ─── Orphan Cleanup ───

  markOrphanedTasksFailed(): number {
    let count = 0;
    for (const task of this.tasks) {
      if (task.status === 'active') {
        task.status = 'failed';
        task.notes = (task.notes ? task.notes + ' | ' : '') + 'Marked failed on restart (orphaned)';
        this.audit('system', 'orphan_cleanup', task.id, `Orphaned active task marked failed: ${task.title}`);
        count++;
      }
    }
    if (count > 0) {
      this.flush();
      this.logger.warn({ count }, 'Orphaned active tasks marked as failed');
    }
    return count;
  }

  // ─── Helpers ───

  private nextId(): number {
    const ids = this.tasks.map((t) => {
      const match = t.id.match(/task-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    });
    return Math.max(0, ...ids) + 1;
  }

  private audit(actor: 'ceo' | 'human' | 'system', action: string, taskId: string | undefined, detail: string): void {
    const entry: AuditEntry = { timestamp: new Date().toISOString(), actor, action, taskId, detail };
    try {
      // Rotate if over 1MB
      if (existsSync(this.auditPath)) {
        const stat = statSync(this.auditPath);
        if (stat.size > 1024 * 1024) {
          const bakPath = this.auditPath.replace('.jsonl', `-${new Date().toISOString().split('T')[0]}.jsonl.bak`);
          renameSync(this.auditPath, bakPath);
        }
      }
      appendFileSync(this.auditPath, JSON.stringify(entry) + '\n');
    } catch { /* non-fatal */ }
  }
}
