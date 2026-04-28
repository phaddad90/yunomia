import type { AgentCode } from './types.js';
import { AGENT_EMOJI } from './types.js';

/**
 * Per-agent pre-compact prompts (PH-091). Pasted into an agent's terminal
 * just before `/compact` so they save in-flight work to a resume pointer,
 * post a one-line standby comment on each open ticket, and ack — without
 * starting new work.
 *
 * Templates are hardcoded for v1 (matches the PH-073 kickoff pattern).
 * PH-090 will move both kickoffs and pre-compacts into platform DB once
 * SA's bundle deploys; this file becomes a thin client at that point.
 */

interface AgentRole {
  code: AgentCode;
  resumeFile: string;
}

type PrecompactAgent = Exclude<AgentCode, 'PETER'>;

const ROLES: Record<PrecompactAgent, AgentRole> = {
  SA:  { code: 'SA',  resumeFile: 'SA-resume.md' },
  AD:  { code: 'AD',  resumeFile: 'AD-resume.md' },
  WA:  { code: 'WA',  resumeFile: 'WA-resume.md' },
  DA:  { code: 'DA',  resumeFile: 'DA-resume.md' },
  QA:  { code: 'QA',  resumeFile: 'QA-resume.md' },
  WD:  { code: 'WD',  resumeFile: 'WD-resume.md' },
  CEO: { code: 'CEO', resumeFile: 'CEO-resume.md' },
  TA:  { code: 'TA',  resumeFile: 'TA-resume.md' },
};

const SAAS_ARCH_DIR = '/Users/peter/Desktop/Websites/prooflab/SaaS Architect';

export function buildPrecompactPrompt(code: AgentCode): string {
  if (code === 'PETER') return '';
  const role = ROLES[code as PrecompactAgent];
  if (!role) return '';
  const emoji = AGENT_EMOJI[code];

  if (code === 'CEO') return ceoPrecompact();
  if (code === 'TA')  return taPrecompact();

  return [
    `You are about to be \`/compact\`d. Pre-compact ritual — five steps, no shortcuts.`,
    ``,
    `**1. Verify nothing is mid-edit.** If you have uncommitted work:`,
    `   - Save it locally. **Do not deploy.**`,
    `   - Note the in-flight state in your next comment (step 3).`,
    ``,
    `**2. Update your resume pointer at:**`,
    `   \`${SAAS_ARCH_DIR}/${role.resumeFile}\``,
    `   - Append a \`## Pre-compact <YYYY-MM-DD HH:MM>\` section.`,
    `   - 5–10 lines: what you're mid-task on, which files you touched, what to resume next, any open blockers.`,
    `   - Keep it scannable — your post-compact self reads this first.`,
    ``,
    `**3. For every ticket assigned to you in \`(in_progress, in_review)\`,** post a one-line standby comment with the mandatory header:`,
    ``,
    `   \`\`\``,
    `   ## ${emoji} ${role.code} — pre-compact handoff — Standby`,
    `   \`\`\``,
    ``,
    `   Body: where the work is (file:line if useful), what's next, any blockers. Don't paste tool-call output. One short paragraph or a 3-bullet list.`,
    ``,
    `   Pull your queue first if you're not sure what's open:`,
    `     curl -H "x-pp-agent-token: $AGENT_API_TOKEN" -H "x-pp-agent-id: ${role.code}" \\`,
    `       https://admin.printpepper.co.uk/api/admin/tickets/queue?assignee=${role.code}`,
    ``,
    `**4. Final ack — single message back to me here (your terminal, not the board):**`,
    ``,
    `   \`\`\``,
    `   Pre-compact done. Resume pointer at SaaS Architect/${role.resumeFile}. Standing by for /compact.`,
    `   \`\`\``,
    ``,
    `**5. Wait for \`/compact\`.** Do **not** deploy. Do **not** start new work. Just save state and ack.`,
    ``,
  ].join('\n');
}

function ceoPrecompact(): string {
  return [
    `You are 🎯 CEO and about to be \`/compact\`d. Pre-compact ritual — orchestrator variant.`,
    ``,
    `**1. Sync open relays + decisions to the board.** If you have agent prompts mid-draft, agent reports mid-read, or routing decisions in flight: convert them into ticket comments / new tickets / status moves now. Memory after compact will be what's on the board, not what's in your head.`,
    ``,
    `**2. Update your resume + state file at:**`,
    `   \`${SAAS_ARCH_DIR}/CEO-resume.md\``,
    `   - Append a \`## Pre-compact <YYYY-MM-DD HH:MM>\` section.`,
    `   - **Update or replace the \`## CURRENT STATE\` block** at the top with the marathon's live snapshot: phase progress, locked decisions today, who's blocking whom, what's in deploy bundle, any open commitments to Peter.`,
    `   - 8–15 lines for CURRENT STATE; 5–10 lines for the pre-compact note. The post-compact CEO scans CURRENT STATE first.`,
    ``,
    `**3. For every ticket assigned to CEO in \`(triage, assigned, in_progress, in_review)\`,** post a one-line standby comment with the mandatory header:`,
    ``,
    `   \`\`\``,
    `   ## 🎯 CEO — pre-compact handoff — Standby`,
    `   \`\`\``,
    ``,
    `   Body: routing decision (if you've made one), open question (if you haven't), or "park, will return after compact". Keep it tight.`,
    ``,
    `   Pull queue first if needed:`,
    `     curl -H "x-pp-agent-token: $AGENT_API_TOKEN" -H "x-pp-agent-id: CEO" \\`,
    `       https://admin.printpepper.co.uk/api/admin/tickets/queue?assignee=CEO`,
    ``,
    `**4. Drain the inbox one last time** so accumulated events from the marathon land in the board before the compact wipes you:`,
    ``,
    `     cd /Users/peter/Desktop/Project\\ Eunomia/app && npm run drain-inbox --silent`,
    ``,
    `   For any unprocessed entries that imply a decision: convert to a board action (assign / comment / patch) before acking.`,
    ``,
    `**5. Final ack — single message back to me here (this terminal, not the board):**`,
    ``,
    `   \`\`\``,
    `   Pre-compact done. CURRENT STATE refreshed at SaaS Architect/CEO-resume.md. Inbox drained. Standing by for /compact.`,
    `   \`\`\``,
    ``,
    `**6. Wait for \`/compact\`.** No new prompts to agents. No status moves. No deploys. Just save state and ack.`,
    ``,
  ].join('\n');
}

function taPrecompact(): string {
  return [
    `You are 🛠 TA and about to be \`/compact\`d. Pre-compact ritual — Mission Control variant.`,
    ``,
    `**1. Commit local Mission Control state.** If you have uncommitted changes on \`feature/printpepper-mission-control\` (or any TA branch):`,
    `   - \`cd /Users/peter/Desktop/Project\\ Eunomia\``,
    `   - \`git status\` → review what's mid-edit.`,
    `   - Either commit cleanly with a "WIP: <topic> — pre-compact" message, **or** stash with a label, **or** revert if it's exploratory junk. Do not leave the working tree dirty.`,
    `   - **Do not deploy.** Do not push to main. Do push the feature branch if you committed.`,
    ``,
    `**2. Verify Mission Control still serves cleanly:**`,
    `   - \`curl -s http://localhost:4600/health\` should return \`status: "ok"\`.`,
    `   - If MC is wedged, leave a \`note-to-self\` line in your resume pointer (step 3) — don't try to fix it during pre-compact.`,
    ``,
    `**3. Update your resume pointer at:**`,
    `   \`${SAAS_ARCH_DIR}/TA-resume.md\``,
    `   - Append a \`## Pre-compact <YYYY-MM-DD HH:MM>\` section.`,
    `   - 5–10 lines: branch HEAD commit hash, last shipped ticket, any in-flight design discussions, the \`~/.printpepper/\` files state (inbox unprocessed count, presence ticker last fire), known platform-side prereqs (e.g. PH-072/PH-090 deploy gaps).`,
    ``,
    `**4. For every TA ticket in \`(in_progress, in_review)\` on the board,** post a one-line standby comment:`,
    ``,
    `   \`\`\``,
    `   ## 🛠 TA — pre-compact handoff — Standby`,
    `   \`\`\``,
    ``,
    `   Body: branch HEAD, what's blocked-on-deploy vs ready-for-CEO-verify, any follow-up tickets to open after compact.`,
    ``,
    `**5. Final ack — single message back to me here (this terminal, not the board):**`,
    ``,
    `   \`\`\``,
    `   Pre-compact done. TA-resume.md updated, branch pushed at <hash>. Standing by for /compact.`,
    `   \`\`\``,
    ``,
    `**6. Wait for \`/compact\`.** No new builds. No deploys. No \`npm run dev\` restarts (let the detached server keep running). Just save state and ack.`,
    ``,
  ].join('\n');
}

export const ALLOWED_AGENT_CODES_FOR_PRECOMPACT: AgentCode[] = ['SA', 'AD', 'WA', 'DA', 'QA', 'WD', 'CEO', 'TA'];
