// Yunomia — onboarding view.
//
// New project = no tickets, no agents, no kanban. Just the lead-agent flow:
// user chats with a Lead pty, Lead writes brief.md, when ready user clicks
// "Approve brief — go active" and the dashboard flips to kanban mode.

import { invoke } from '@tauri-apps/api/core';

const FOUNDER_KICKOFF = (projectName, projectPath, briefPath) => `\
You are the LEAD agent for a brand-new Yunomia project.

Project: ${projectName}
Path: ${projectPath}
Brief file: ${briefPath}

Right now there is no brief, no tickets, no other agents. Your job is the
onboarding interview. You will:

1. Interview the user about the project.
   Ask, in order, with brief follow-ups:
   - One-liner: in one sentence, what is this project?
   - Primary goals: what does "done" look like? Be concrete — list outcomes.
   - Stakeholders: who uses this? Who cares about it shipping?
   - Constraints: deadlines, must-use tech, hard non-negotiables.
   - Deploy targets: local-only, staging, production, internal-tool, public SaaS?
   - Current state: greenfield, or building on existing code?
   - Open questions: anything you (the user) are unsure about?

2. As the conversation goes, write your evolving understanding to
   ${briefPath}
   using this template:

   # ${projectName}
   ## One-liner
   ## Primary goals
   ## Stakeholders
   ## Constraints
   ## Deploy targets
   ## Current state
   ## Open questions

   Use the Write tool to update the file. Update incrementally, don't wait
   for the full interview to finish.

3. When you and the user agree the brief is solid, propose:
   - The agent fleet this project needs (CEO/SA/AD/QA/etc) with which model
     each should run on. Justify each pick in one sentence.
   - The first 5–10 tickets, scoped tight: title, type, audience, one-line
     body, suggested assignee.

   Do NOT create agents or tickets directly. Write proposals to the brief.md
   under "Proposed agents" and "Proposed initial tickets" sections. The user
   approves in the UI; Yunomia spawns + creates from there.

4. Be a real lead, not a yes-bot:
   - Push back when scope is fuzzy.
   - Flag when the user is conflating goals with implementation.
   - Surface tradeoffs the user hasn't seen.

Talk to the user now. Start with question 1.
`;

export async function loadOnboardingForProject(cwd) {
  const [stateRes, briefRes] = await Promise.all([
    invoke('project_state_get', { args: { cwd } }).catch(() => null),
    invoke('brief_get', { args: { cwd } }).catch(() => ''),
  ]);
  return { state: stateRes || { phase: 'onboarding' }, brief: briefRes || '' };
}

export async function setProjectName(cwd, name) {
  return invoke('project_state_set', { args: { cwd, patch: { project_name: name } } });
}

export async function approveBrief(cwd) {
  return invoke('project_state_set', { args: { cwd, patch: { phase: 'active', brief_finalised_at: new Date().toISOString() } } });
}

export async function reopenOnboarding(cwd) {
  return invoke('project_state_set', { args: { cwd, patch: { phase: 'onboarding', brief_finalised_at: null } } });
}

export async function markLeadSpawned(cwd) {
  return invoke('project_state_set', { args: { cwd, patch: { lead_spawned_at: new Date().toISOString() } } });
}

// Render the onboarding view into a container element.
// `spawnAgent(code, model, cwd, opts)` is the spawn function from main.js.
// `leadRunning` is the live pty status, NOT the stored flag — pty dies on app
// restart, so we check the actual registry every render instead of trusting
// state.lead_spawned_at (which was useful once but now misleads after a quit).
export function renderOnboardingView({ container, cwd, state, brief, spawnAgent, onApproved, leadRunning = false }) {
  if (!container) return;
  const projectName = state.project_name || projectLabel(cwd);
  const briefPath = `~/.yunomia/projects/${cwd.replace(/^\//, '').replace(/\//g, '-').replace(/ /g, '_')}/brief.md`;
  const briefHasContent = (brief || '').trim().length > 50;
  container.innerHTML = `
    <div class="onb">
      <header class="onb-header">
        <h1>${escapeHtml(projectName)}</h1>
        <div class="onb-stage">stage: <b>onboarding</b></div>
      </header>
      <div class="onb-grid">
        <section class="onb-left">
          <h3>Lead agent</h3>
          ${leadRunning
            ? `<p>Lead is running in the <b>LEAD</b> tab. Talk to them about your goals — they'll write the brief here as you go.</p>`
            : `<p>The lead agent will interview you about goals, scope, and constraints, then write the brief and propose an initial agent fleet + ticket list.</p>
               <div class="onb-form">
                 <label>Project name</label>
                 <input id="onb-project-name" type="text" value="${escapeHtml(projectName)}" />
                 <button id="onb-spawn-lead" class="btn-primary" type="button">Spawn lead agent</button>
               </div>`}
          <h3 style="margin-top:24px">Brief</h3>
          <pre class="onb-brief">${brief ? escapeHtml(brief) : '<span class="onb-brief-empty">Brief will appear here as the lead agent writes it.</span>'}</pre>
          <button id="onb-refresh-brief" class="btn-ghost" type="button">↻ Refresh brief</button>
        </section>
        <aside class="onb-right">
          <h3>What happens here</h3>
          <ol class="onb-steps">
            <li><b>Spawn lead.</b> A Claude Code session opens in the LEAD tab.</li>
            <li><b>Interview.</b> Lead asks you about goals, scope, constraints, deploy targets.</li>
            <li><b>Brief written.</b> Lead writes <code>brief.md</code> incrementally as you talk.</li>
            <li><b>Proposals.</b> Lead suggests agent fleet + initial tickets in the brief.</li>
            <li><b>Approve.</b> You click "Approve brief" — Yunomia switches to active mode and the kanban becomes available.</li>
          </ol>
          <div class="onb-approve-row">
            <button id="onb-approve" class="btn-primary" type="button" ${briefHasContent ? '' : 'disabled'}>Approve brief — go active</button>
            ${briefHasContent ? '' : '<small>Available once the brief has real content (>50 chars).</small>'}
          </div>
        </aside>
      </div>
    </div>
  `;
  // Wire handlers
  const spawnBtn = container.querySelector('#onb-spawn-lead');
  if (spawnBtn) {
    spawnBtn.addEventListener('click', async () => {
      const name = container.querySelector('#onb-project-name')?.value.trim() || projectLabel(cwd);
      await setProjectName(cwd, name);
      const kickoff = FOUNDER_KICKOFF(name, cwd, briefPath);
      await spawnAgent('LEAD', 'claude-opus-4-7', cwd, { kickoff });
      await markLeadSpawned(cwd);
      // Re-render
      const fresh = await loadOnboardingForProject(cwd);
      renderOnboardingView({ container, cwd, state: fresh.state, brief: fresh.brief, spawnAgent, onApproved, leadRunning: true });
    });
  }
  const refreshBtn = container.querySelector('#onb-refresh-brief');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const fresh = await loadOnboardingForProject(cwd);
      renderOnboardingView({ container, cwd, state: fresh.state, brief: fresh.brief, spawnAgent, onApproved, leadRunning });
    });
  }
  const approveBtn = container.querySelector('#onb-approve');
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      if (!confirm(`Approve brief for "${projectName}" and go active? Kanban + ticket creation will unlock.`)) return;
      await approveBrief(cwd);
      onApproved && onApproved();
    });
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function projectLabel(p) {
  if (!p) return '?';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}
