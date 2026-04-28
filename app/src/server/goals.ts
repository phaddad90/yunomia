import type { AgentCode } from './types.js';
import { AGENT_EMOJI } from './types.js';

/**
 * Per-agent goals files (PH-092). Same MC-local file-backed pattern as
 * kickoff (PH-090): GET reads, POST writes, default seed if missing.
 *
 * Goals are short-form KPI / sprint-target / "what success looks like"
 * notes per agent. The format is intentionally loose — Markdown,
 * editable inline from the dashboard side panel.
 */

export const ALLOWED_AGENT_CODES_FOR_GOALS: AgentCode[] = ['SA', 'AD', 'WA', 'DA', 'QA', 'WD', 'CEO', 'TA', 'PETER'];

export const SAAS_ARCH_GOALS_DIR = '/Users/peter/Desktop/Websites/prooflab/SaaS Architect';
export function goalsFilePath(code: AgentCode): string {
  return `${SAAS_ARCH_GOALS_DIR}/${code}-goals.md`;
}

interface AgentGoalSeed {
  role: string;
  bullets: string[];
}

const SEEDS: Record<AgentCode, AgentGoalSeed> = {
  SA:    { role: 'SaaS Architect',     bullets: [
    'Admin portal stable: zero P1 outages per week.',
    'Multi-tenant infra: schema migrations apply clean to fresh PG every time (BUG-5 invariant holds).',
    'Audit append-only invariant preserved on every PATCH path.',
    'Lessons logged in Bug Lessons KB after every fix.',
  ]},
  AD:    { role: 'App Developer',      bullets: [
    'Tenant app feature velocity: ship at least one customer-visible improvement per week.',
    'Edit-contract allow-list stays in lockstep with the UI form (no silent dropped fields).',
    'JobState union covers VALID_STATES (no `as string` workarounds).',
    'Both DB drivers tested before any tenant-DB migration ships.',
  ]},
  WA:    { role: 'Workflow Architect', bullets: [
    'Engine evolves locally only — never deploys to prod.',
    'Flow editor changes round-trip through AD for tenant adjacency.',
    'Pipeline stays composable: each node independently testable.',
  ]},
  DA:    { role: 'Docs Agent',         bullets: [
    'In-app help, public API docs, tooltips current within 24h of any user-facing change.',
    'Marketing-site / docs-site FTP pushes audited.',
    'Lawyer-reviewed legal copy used verbatim once approved (no agent rewriting).',
  ]},
  QA:    { role: 'QA Agent',           bullets: [
    'Every deploy bundle has a PASSed gate file before SA/AD ship.',
    'Helper-mismatch class of outages: zero tolerance (BUG-5 catches them at gate time).',
    'No production code — gate plans, fixtures, verdicts only.',
  ]},
  WD:    { role: 'Website Developer',  bullets: [
    'printpepper.co.uk loads under 2s on 4G.',
    'Public changelog / roadmap pages auto-update from board (Released app-side).',
    'Marketing-site lane only — no admin-portal or tenant-app touches.',
  ]},
  CEO:   { role: 'Coordinator',        bullets: [
    'Every agent on the board has at most one ticket in (assigned, in_progress) at a time.',
    'Drip prompts only — never queue downstream prompts speculatively.',
    'CURRENT STATE block in CEO-resume.md refreshed every compact.',
    'Token economy: replies <50 lines, prompts <30 lines.',
  ]},
  TA:    { role: 'Tooling Agent',      bullets: [
    'Mission Control survives restarts: state in `~/.printpepper/`, not memory.',
    'Every MC ticket ships independently (commit + restart + verify); no SA gating.',
    'Light + zinc + pepper preserved; no dark mode, no purples.',
    'Zero calls to api.anthropic.com from MC.',
  ]},
  PETER: { role: 'Human (CEO of the human company)', bullets: [
    'Make irreversible decisions promptly (deploys, secrets, legal sign-offs, FTP creds).',
    'Read the dashboard at http://localhost:4600 once a day at minimum.',
    'Drain the inbox before the agents pile up unread events.',
    'Rest. The fleet does the work; you make the calls.',
  ]},
};

/** Default goals body for the seed-on-missing path. */
export function buildDefaultGoals(code: AgentCode): string {
  const seed = SEEDS[code];
  const emoji = AGENT_EMOJI[code];
  if (!seed) return `# ${emoji} ${code} — Goals\n\n_(set goals here)_\n`;
  const lines = [
    `# ${emoji} ${code} — Goals`,
    ``,
    `**Role:** ${seed.role}`,
    ``,
    `## Standing goals`,
    ``,
    ...seed.bullets.map((b) => `- ${b}`),
    ``,
    `## Sprint goals`,
    ``,
    `_(refresh per sprint)_`,
    ``,
  ];
  return lines.join('\n');
}
