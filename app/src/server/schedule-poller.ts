import type { Logger } from 'pino';
import type { ScheduleStore, ScheduleEntry } from './schedule-store.js';
import type { Notifier } from './notifier.js';

// PH-118: minute-tick poller. On each tick, fire macOS notifications for any
// schedules whose time has arrived and not yet been notified, then mark them.
export class SchedulePoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: ScheduleStore,
    private notifier: Notifier,
    private logger: Logger,
    private onTick: (entries: ScheduleEntry[]) => void = () => {},
    private intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private tick(): void {
    const due = this.store.dueNow();
    if (!due.length) return;
    for (const e of due) {
      const id = e.ticket_human_id || e.ticket_id;
      const title = e.ticket_title ? ` — ${e.ticket_title}` : '';
      this.notifier.notify(`${id} scheduled time hit${title}`);
      this.logger.info({ ticket_id: e.ticket_id, scheduled_for: e.scheduled_for }, 'schedule fired');
    }
    this.store.markFired(due);
    this.onTick(due);
  }
}
