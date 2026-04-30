import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Logger } from 'pino';

export interface ScheduleEntry {
  ticket_id: string;
  ticket_human_id?: string | null;
  ticket_title?: string | null;
  scheduled_for: string;
  set_by: string;
  set_at: string;
}

// MC-local scheduled-for store (PH-118). File-backed JSON keyed by ticket_id.
// No platform DB dependency — see feedback_mc_deploy_ownership memory rule.
export class ScheduleStore {
  private dir: string;
  private path: string;
  private firedPath: string;
  private map = new Map<string, ScheduleEntry>();
  private fired = new Set<string>();

  constructor(rootDir = join(homedir(), '.printpepper'), private logger?: Logger) {
    this.dir = rootDir;
    this.path = join(rootDir, 'ticket-schedules.json');
    this.firedPath = join(rootDir, 'ticket-schedules-fired.json');
  }

  init(): void {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.path)) {
      try {
        const obj = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, ScheduleEntry>;
        for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
      } catch (err) { this.logger?.warn({ err: String(err) }, 'schedule-store: failed to parse JSON'); }
    }
    if (existsSync(this.firedPath)) {
      try {
        const arr = JSON.parse(readFileSync(this.firedPath, 'utf-8')) as string[];
        for (const k of arr) this.fired.add(k);
      } catch { /* ignore */ }
    }
    this.logger?.info({ scheduled: this.map.size, fired: this.fired.size }, 'schedule store loaded');
  }

  set(entry: ScheduleEntry): void {
    this.map.set(entry.ticket_id, entry);
    this.persist();
  }

  clear(ticketId: string): boolean {
    if (!this.map.has(ticketId)) return false;
    this.map.delete(ticketId);
    this.persist();
    return true;
  }

  get(ticketId: string): ScheduleEntry | undefined { return this.map.get(ticketId); }
  list(): ScheduleEntry[] { return [...this.map.values()]; }

  // Entries with scheduled_for <= now and not yet fired since last set/reset.
  dueNow(now: Date = new Date()): ScheduleEntry[] {
    const out: ScheduleEntry[] = [];
    for (const e of this.map.values()) {
      if (new Date(e.scheduled_for) > now) continue;
      if (this.fired.has(this.firedKey(e))) continue;
      out.push(e);
    }
    return out;
  }

  // All entries already due (regardless of fired flag) — used by the kickoff/
  // reorientation surfacing where we always want to list overdue items.
  allDue(now: Date = new Date()): ScheduleEntry[] {
    return this.list().filter((e) => new Date(e.scheduled_for) <= now);
  }

  markFired(entries: ScheduleEntry[]): void {
    if (!entries.length) return;
    for (const e of entries) this.fired.add(this.firedKey(e));
    writeFileSync(this.firedPath, JSON.stringify([...this.fired], null, 2));
  }

  private firedKey(e: ScheduleEntry): string { return `${e.ticket_id}|${e.scheduled_for}`; }

  private persist(): void {
    const obj: Record<string, ScheduleEntry> = {};
    for (const [k, v] of this.map.entries()) obj[k] = v;
    writeFileSync(this.path, JSON.stringify(obj, null, 2));
    // A reset of scheduled_for invalidates any prior fired flag — but since
    // the fired key is composite (id|scheduled_for) a new time auto-resets.
    // We don't need to scrub the fired set explicitly.
  }
}
