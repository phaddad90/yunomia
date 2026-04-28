// Mission Control types — mirrors PrintPepper /admin/board API contracts.

export type TicketStatus =
  | 'backlog'
  | 'triage'
  | 'assigned'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'released';

export type TicketType = 'bug' | 'feature' | 'doc' | 'gate' | 'migration' | 'ops';
export type TicketAudience = 'app' | 'admin';
export type AgentCode = 'SA' | 'AD' | 'WA' | 'DA' | 'QA' | 'WD' | 'CEO' | 'TA' | 'PETER';

export interface Ticket {
  id: string;
  ticket_human_id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  body_md: string;
  assignee_agent: AgentCode | null;
  audience: TicketAudience;
  references_json?: string | null;
  diagnostics_json?: string | null;
  tenant_id?: string | null;
  job_id?: string | null;
  created_at: string;
  updated_at: string;
  released_at?: string | null;
  recent_comments?: TicketComment[];
}

export interface TicketComment {
  id: string;
  ticket_id: string;
  body_md: string;
  author_kind: 'admin' | 'agent';
  author_id: string | null;
  author_label: string;
  created_at: string;
}

export interface AuditRow {
  id: number;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface MissionConfig {
  port: number;
  apiBase: string;
  agentToken: string;
  agentCode: AgentCode;
  webhookSecret?: string;
  auditPollMs: number;
}

export type WsMessage =
  | { type: 'hello'; data: { agentCode: AgentCode; serverTime: string } }
  | { type: 'tickets_changed'; data: { reason: string } }
  | { type: 'ticket.created'; data: { event_id: string; ticket: Ticket } }
  | {
      type: 'ticket.changed';
      data: {
        event_id: string;
        ticket_id: string;
        ticket_human_id: string;
        fields_changed: string[];
        after: Partial<Ticket>;
      };
    }
  | { type: 'comment.added'; data: { event_id: string; ticket_id: string; ticket_human_id: string; comment: TicketComment } }
  | { type: 'comment.deleted'; data: { event_id: string; ticket_id: string; comment_id: string } }
  | { type: 'audit_event'; data: AuditRow }
  | { type: 'agent_state'; data: AgentState[] }
  | { type: 'inbox_changed'; data: { unprocessed: number } }
  | { type: 'identity_changed'; data: { agentCode: AgentCode; previous: AgentCode } }
  | { type: 'presence_changed'; data: { presence: AgentPresence[] } }
  | { type: 'toast'; data: { kind: 'info' | 'error' | 'success'; text: string } };

export interface AgentState {
  code: AgentCode;
  emoji: string;
  light: 'idle' | 'standby' | 'running' | 'blocked';
  current?: { ticket_human_id: string; status: TicketStatus; title: string };
  queueCount: number;
}

export const AGENT_EMOJI: Record<AgentCode, string> = {
  SA: '🟧',
  AD: '🟦',
  WA: '🟪',
  DA: '🟨',
  QA: '🟥',
  WD: '🌐',
  CEO: '🎯',
  TA: '🛠',
  PETER: '🎩',
};

// Codes shown on the agent rail. CEO leads the list ("at top of rail" per
// PH-089) since CEO is the orchestrator. PETER is the human assignee —
// appears on the rail so blockers/decisions surface visually, but excluded
// from any auth-as-X path (identity switcher, kickoff prompts, heartbeat
// ticker — see below).
export const AGENT_LIST: AgentCode[] = ['CEO', 'SA', 'AD', 'WA', 'DA', 'QA', 'WD', 'PETER'];

// Codes a Mission Control instance can authenticate AS. Peter is human; he
// does not call the admin API as an agent — only ever appears as assignee.
export const AGENTS_THAT_CAN_AUTH: AgentCode[] = ['SA', 'AD', 'WA', 'DA', 'QA', 'WD', 'CEO', 'TA'];

export interface AgentPresence {
  agent_code: AgentCode;
  last_seen_at: string;          // ISO timestamp; epoch (1970) for never-seen
  current_ticket_id: string | null;
  current_ticket_human_id: string | null;
  idle_since: string | null;
  paused: boolean;
  pause_reason: string | null;
  is_alive?: boolean;            // server-side computed (last_seen_at < 60s ago)
}
