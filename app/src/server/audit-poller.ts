import type { Logger } from 'pino';
import type { PrintPepperBoardClient } from './board-client.js';
import type { AuditRow } from './types.js';

const TICKET_ACTIONS = new Set([
  'ticket.created',
  'ticket.commented',
  'ticket.status_changed',
  'ticket.assigned',
  'ticket.updated',
  'ticket.comment.deleted',
]);

export class AuditPoller {
  private cursor: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private client: PrintPepperBoardClient,
    private intervalMs: number,
    private logger: Logger,
    private onEvent: (row: AuditRow) => void,
    private onTicketDelta: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      const since = this.cursor ? new Date(this.cursor).toISOString() : null;
      // first poll: no `since` — just establish a cursor without flooding clients
      const rows = await this.client.getAuditSince(since, since ? 200 : 1);
      let sawTicketEvent = false;
      for (const row of rows) {
        const ts = new Date(row.created_at).getTime();
        if (this.cursor && ts <= this.cursor) continue;
        this.cursor = ts;
        if (TICKET_ACTIONS.has(row.action)) {
          sawTicketEvent = true;
          this.onEvent(row);
        }
      }
      if (rows.length && !this.cursor) {
        this.cursor = new Date(rows[rows.length - 1].created_at).getTime();
      }
      if (sawTicketEvent) this.onTicketDelta();
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'audit poll failed');
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
      }
    }
  }
}
