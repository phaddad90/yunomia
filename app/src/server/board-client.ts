import type { AgentCode, AuditRow, Ticket, TicketAudience, TicketComment, TicketStatus, TicketType } from './types.js';

export class BoardError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`Board API ${status}: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export class PrintPepperBoardClient {
  constructor(
    private apiBase: string,
    private token: string,
    /** Mutable: identity-switcher in v0.3.0 changes this at runtime. Pass a getter
     * if the host needs to swap codes without recreating the client. */
    private agentCodeRef: { current: AgentCode } | AgentCode,
  ) {}

  /** Currently active agent code. Reads through the live ref each call. */
  get agentCode(): AgentCode {
    return typeof this.agentCodeRef === 'string' ? this.agentCodeRef : this.agentCodeRef.current;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.apiBase}${path}`;
    const headers: Record<string, string> = {
      'x-pp-agent-token': this.token,
      'x-pp-agent-id': this.agentCode,
      ...((init.headers as Record<string, string>) || {}),
    };
    if (init.body && !headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) throw new BoardError(res.status, parsed);
    return parsed as T;
  }

  // ─── Reads ───

  async listTickets(params: {
    status?: string;
    assignee?: AgentCode | string;
    audience?: TicketAudience;
    q?: string;
    limit?: number;
  } = {}): Promise<Ticket[]> {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.assignee) qs.set('assignee_agent', String(params.assignee));
    if (params.audience) qs.set('audience', params.audience);
    if (params.q) qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    const r = await this.req<{ tickets: Ticket[] }>(`/api/admin/tickets${query ? '?' + query : ''}`);
    return r.tickets || [];
  }

  async getTicket(id: string): Promise<{ ticket: Ticket; audit: AuditRow[]; comments?: TicketComment[] }> {
    return this.req(`/api/admin/tickets/${encodeURIComponent(id)}`);
  }

  async listComments(ticketId: string): Promise<TicketComment[]> {
    const r = await this.req<{ comments: TicketComment[] }>(`/api/admin/tickets/${encodeURIComponent(ticketId)}/comments`);
    return r.comments || [];
  }

  async getQueue(assignee: AgentCode): Promise<Ticket[]> {
    const r = await this.req<{ queue: Ticket[] }>(`/api/admin/tickets/queue?assignee=${assignee}`);
    return r.queue || [];
  }

  async getAuditSince(sinceIso: string | null, limit = 100): Promise<AuditRow[]> {
    const qs = new URLSearchParams();
    if (sinceIso) qs.set('since', sinceIso);
    qs.set('limit', String(limit));
    const r = await this.req<{ rows: AuditRow[] }>(`/api/admin/audit?${qs.toString()}`);
    // API returns newest-first; sort oldest-first so callers can advance a cursor
    return (r.rows || []).slice().sort((a, b) => a.id - b.id);
  }

  // ─── Writes ───

  async createTicket(input: {
    title: string;
    body_md: string;
    type?: TicketType;
    audience: TicketAudience;
    assignee_agent?: AgentCode | null;
    status?: string;
  }): Promise<Ticket> {
    // API uses camelCase `bodyMd` on writes; reads return `body_md`.
    const r = await this.req<{ ticket: Ticket }>(`/api/admin/tickets`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        bodyMd: input.body_md,
        type: input.type || 'ops',
        audience: input.audience,
        assignee_agent: input.assignee_agent ?? 'CEO',
        status: input.status || 'triage',
      }),
    });
    return r.ticket;
  }

  async postComment(ticketId: string, body_md: string): Promise<TicketComment> {
    const r = await this.req<{ comment: TicketComment }>(`/api/admin/tickets/${encodeURIComponent(ticketId)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ bodyMd: body_md }),
    });
    return r.comment;
  }

  // Fast-path transitions return `{ success, status, alreadyDone? }`, not a full ticket.
  async start(ticketId: string): Promise<{ status: TicketStatus | 'in_progress'; success: boolean }> {
    return this.req(`/api/admin/tickets/${encodeURIComponent(ticketId)}/start`, { method: 'POST' });
  }
  async handoff(ticketId: string): Promise<{ status: TicketStatus | 'in_review'; success: boolean }> {
    return this.req(`/api/admin/tickets/${encodeURIComponent(ticketId)}/handoff`, { method: 'POST' });
  }
  async done(ticketId: string): Promise<{ status?: TicketStatus | 'done'; success: boolean; alreadyDone?: boolean }> {
    return this.req(`/api/admin/tickets/${encodeURIComponent(ticketId)}/done`, { method: 'POST' });
  }

  async patch(ticketId: string, fields: Partial<Ticket>): Promise<{ success: boolean }> {
    return this.req(`/api/admin/tickets/${encodeURIComponent(ticketId)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
  }
}
