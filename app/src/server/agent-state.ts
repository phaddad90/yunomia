import type { AgentCode, AgentState, Ticket } from './types.js';
import { AGENT_EMOJI, AGENT_LIST } from './types.js';

const ACTIVE = new Set(['assigned', 'in_progress', 'in_review']);

export function deriveAgentStates(tickets: Ticket[], blocked: Set<AgentCode> = new Set()): AgentState[] {
  return AGENT_LIST.map((code) => {
    const own = tickets.filter((t) => t.assignee_agent === code && ACTIVE.has(t.status));
    let light: AgentState['light'] = 'idle';
    if (blocked.has(code)) light = 'blocked';
    else if (own.some((t) => t.status === 'in_progress')) light = 'running';
    else if (own.length > 0) light = 'standby';

    const headline = own.find((t) => t.status === 'in_progress') || own[0];
    return {
      code,
      emoji: AGENT_EMOJI[code],
      light,
      current: headline
        ? { ticket_human_id: headline.ticket_human_id, status: headline.status, title: headline.title }
        : undefined,
      queueCount: own.length,
    };
  });
}
