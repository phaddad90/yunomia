// Yunomia frontend — pane manager + xterm.js mounting per pty.
// Conventions:
//   • Each pty has a stable string id (typically the AGENT code: "CEO", "QA").
//   • Tauri events: `pty://output/<id>` carries stdout/stderr; `pty://exit/<id>` fires on child exit.
//   • Resize event triggers TIOCSWINSZ via `pty_resize` invoke.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { initCompactOrchestrator, noteTaskBoundary, firePreCompact } from './lib/compact-orchestrator.js';
import { startHeartbeat, noteWakeupSent, noteStdoutFromAgent } from './lib/heartbeat.js';
import { initKanban, setKanbanProject } from './lib/kanban.js';
import { loadOnboardingForProject, renderOnboardingView, reopenOnboarding } from './lib/onboarding.js';
import { writeToAgent } from './lib/mc-bridge.js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

const AGENT_MODELS_DEFAULT = {
  LEAD:'claude-opus-4-7',
  CEO: 'claude-opus-4-7',
  SA:  'claude-sonnet-4-6',
  AD:  'claude-sonnet-4-6',
  WA:  'claude-sonnet-4-6',
  DA:  'claude-sonnet-4-6',
  QA:  'claude-haiku-4-5-20251001',
  WD:  'claude-sonnet-4-6',
  TA:  'claude-opus-4-7',
};


const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = {
  ptys: new Map(),         // key = `${cwd}|${code}` → { term, fit, unlistens, cwd, code, model, temp, lastStdoutAt, lastWriteAt, blockedReason }
  activePane: 'dashboard',
  stickyModels: {},        // PH-134 Phase 2: agent → model, persisted via Rust store
  maxConcurrent: 3,        // PH-134 Phase 3: concurrency limit slider
  tempAgents: new Set(),   // PH-134 Phase 3: agents flagged for auto-dispose after one task
  projects: [],            // PH-134: known project roots, persisted in localStorage
  selectedProject: '',     // current project cwd (drives spawn + resume)
};

// localStorage keys for projects.
const LS_PROJECTS = 'yunomia.projects';
const LS_SELECTED = 'yunomia.selectedProject';
const ADD_PROJECT_VALUE = '__add__';

function loadProjects() {
  try {
    state.projects = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]');
  } catch { state.projects = []; }
  state.selectedProject = localStorage.getItem(LS_SELECTED) || state.projects[0] || '';
}
function saveProjects() {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(state.projects));
  localStorage.setItem(LS_SELECTED, state.selectedProject || '');
}
function projectLabel(p) {
  // Show last path segment as label.
  if (!p) return '?';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}
function renderProjectPicker() {
  const sel = $('#project-picker');
  if (!sel) return;
  sel.innerHTML = '';
  if (!state.projects.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(none — click to add)'; opt.disabled = true; opt.selected = true;
    sel.appendChild(opt);
  } else {
    for (const p of state.projects) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = projectLabel(p);
      opt.title = p;
      if (p === state.selectedProject) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  const addOpt = document.createElement('option');
  addOpt.value = ADD_PROJECT_VALUE; addOpt.textContent = '+ Add project…';
  sel.appendChild(addOpt);
}
function bindProjectPicker() {
  const sel = $('#project-picker');
  sel.addEventListener('change', () => {
    if (sel.value === ADD_PROJECT_VALUE) {
      openAddProjectModal();
      renderProjectPicker();   // restore previous selection visually until modal commits
      return;
    }
    state.selectedProject = sel.value;
    saveProjects();
    void refreshResumeBanner();
    void window.__renderProjectView?.();
  });
}

function openAddProjectModal() {
  const modal = $('#project-modal');
  if (!modal) return;
  $('#proj-name').value = '';
  $('#proj-path').value = '';
  modal.classList.remove('hidden');
  setTimeout(() => $('#proj-path').focus(), 0);
}
function closeAddProjectModal() { $('#project-modal').classList.add('hidden'); }
function bindAddProjectModal() {
  $('#proj-cancel').addEventListener('click', closeAddProjectModal);
  $('#project-modal').addEventListener('click', (e) => { if (e.target.id === 'project-modal') closeAddProjectModal(); });
  $('#proj-browse').addEventListener('click', async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: 'Pick project root' });
      if (!picked) return;
      $('#proj-path').value = String(picked);
      // Default the name from the basename if user hasn't typed one.
      if (!$('#proj-name').value.trim()) {
        const parts = String(picked).split('/').filter(Boolean);
        $('#proj-name').value = parts[parts.length - 1] || '';
      }
    } catch (err) {
      console.warn('dialog open failed', err);
    }
  });
  $('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = $('#proj-path').value.trim().replace(/\/+$/, '');
    if (!path) return;
    if (!path.startsWith('/')) { alert('Use an absolute path (must start with /)'); return; }
    if (!state.projects.includes(path)) state.projects.push(path);
    state.selectedProject = path;
    saveProjects();
    renderProjectPicker();
    closeAddProjectModal();
    // Optional friendly name → write to project_state
    const name = $('#proj-name').value.trim();
    if (name) {
      try { await invoke('project_state_set', { args: { cwd: path, patch: { project_name: name } } }); } catch { /* ignore */ }
    }
    void refreshResumeBanner();
    void window.__renderProjectView?.();
  });
}

function setActivePane(id) {
  state.activePane = id;
  $$('#pane-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === id));
  $$('#panes .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
  const ent = state.ptys.get(id);
  if (ent) requestAnimationFrame(() => ent.fit.fit());
}

// Show/hide tabs + panes based on currently selected project.
function applyProjectVisibility() {
  const cwd = state.selectedProject;
  $$('#pane-tabs .tab').forEach((t) => {
    if (t.dataset.pane === 'dashboard') return;     // always visible
    t.style.display = (t.dataset.cwd === cwd) ? '' : 'none';
  });
  $$('#panes .pane').forEach((p) => {
    if (p.dataset.pane === 'dashboard') return;
    if (p.dataset.cwd && p.dataset.cwd !== cwd && p.classList.contains('active')) {
      p.classList.remove('active');
      $$('#pane-tabs .tab').forEach((t) => t.classList.remove('active'));
      const dash = $('#pane-tabs .tab[data-pane="dashboard"]');
      const dashPane = $('#panes .pane[data-pane="dashboard"]');
      if (dash) dash.classList.add('active');
      if (dashPane) dashPane.classList.add('active');
      state.activePane = 'dashboard';
    }
  });
}

function bindUi() {
  $$('#pane-tabs .tab').forEach((t) => t.addEventListener('click', () => setActivePane(t.dataset.pane)));
  $('#spawn-agent').addEventListener('click', openSpawnModal);
  $('#spawn-cancel').addEventListener('click', closeSpawnModal);
  $('#spawn-form').addEventListener('submit', (e) => { e.preventDefault(); submitSpawn(); });
  $('#spawn-modal').addEventListener('click', (e) => { if (e.target.id === 'spawn-modal') closeSpawnModal(); });
  window.addEventListener('resize', () => {
    const ent = state.ptys.get(state.activePane);
    if (ent) ent.fit.fit();
  });
}

async function openSpawnModal() {
  // Pre-fill model from sticky persistence per agent code.
  try { state.stickyModels = await invoke('models_get'); } catch { /* ignore */ }
  syncSpawnModelDefault();
  // Pre-fill cwd from the picked project root.
  const cwdInput = $('#spawn-cwd');
  if (cwdInput) cwdInput.value = state.selectedProject || '';
  if (cwdInput) cwdInput.placeholder = state.selectedProject || 'absolute path';
  $('#spawn-code').addEventListener('change', syncSpawnModelDefault, { once: false });
  $('#spawn-modal').classList.remove('hidden');
}
function syncSpawnModelDefault() {
  const code = $('#spawn-code').value;
  const sticky = state.stickyModels?.[code];
  const fallback = AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  $('#spawn-model').value = sticky || fallback;
}
function closeSpawnModal() { $('#spawn-modal').classList.add('hidden'); }

async function submitSpawn() {
  const code = $('#spawn-code').value;
  const model = $('#spawn-model').value || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  const cwd = ($('#spawn-cwd').value || state.selectedProject || '').trim();
  if (!cwd) { alert('Pick a project first (top-bar).'); return; }
  // Auto-add to project list if it's a new path.
  if (!state.projects.includes(cwd)) {
    state.projects.push(cwd);
    state.selectedProject = cwd;
    saveProjects();
    renderProjectPicker();
    void window.__renderProjectView?.();
  }
  const temp = $('#spawn-temp')?.checked || false;
  // PH-134 Phase 3 — concurrency limit guard.
  if (state.ptys.size >= state.maxConcurrent) {
    if (!confirm(`At concurrency limit (${state.maxConcurrent}). Spawn anyway?`)) return;
  }
  closeSpawnModal();
  try {
    await spawnAgent(code, model, cwd, { temp });
  } catch (err) {
    console.error('spawn failed', err);
    alert('Spawn failed: ' + (err?.message || err));
  }
}

// Composite key — same agent code can run independently per project.
// Must be Tauri-event-safe: only [A-Za-z0-9_-]. Slashes and pipes break
// the `pty://output/<id>` event channel silently → black-screen pty.
function ptyKey(cwd, code) {
  const safe = String(cwd).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}__${code}`;
}
function visibleAgents() {
  const out = [];
  for (const [key, ent] of state.ptys.entries()) {
    if (ent.cwd === state.selectedProject) out.push({ key, ent });
  }
  return out;
}

// Spawn one agent in a new pty pane in the given project's cwd.
async function spawnAgent(code, model, cwd, opts = {}) {
  const key = ptyKey(cwd, code);
  if (state.ptys.has(key)) {
    setActivePane(key);
    return;
  }
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.pane = key;
  tabBtn.dataset.cwd = cwd;
  tabBtn.dataset.code = code;
  tabBtn.innerHTML = `<span class="status-dot" data-status="idle"></span><span class="tab-emoji">${tabEmoji(code)}</span> ${code} <span class="tab-close" title="Kill" data-kill="1">×</span>`;
  tabBtn.addEventListener('click', (e) => {
    if (e.target.dataset.kill) { void killPty(key); return; }
    setActivePane(key);
  });
  $('#pane-tabs').appendChild(tabBtn);

  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.pane = key;
  pane.dataset.cwd = cwd;
  const termWrap = document.createElement('div');
  termWrap.className = 'term-wrap';
  pane.appendChild(termWrap);
  $('#panes').appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: '#ffffff',
      foreground: '#1a1a1a',
      cursor: '#d93a00',
      selectionBackground: '#ffe4d6',
      black:   '#1a1a1a',  red:   '#d93a00',  green: '#16a34a',  yellow: '#a16207',
      blue:    '#1d4ed8',  magenta:'#7e22ce', cyan:  '#0891b2',  white:  '#525252',
      brightBlack:'#525252', brightRed:'#dc2626', brightGreen:'#15803d', brightYellow:'#854d0e',
      brightBlue:'#1e40af', brightMagenta:'#6b21a8', brightCyan:'#0e7490', brightWhite:'#1a1a1a',
    },
    convertEol: true,
    scrollback: 10_000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termWrap);
  fit.fit();

  setActivePane(key);

  // Stream stdout from the pty into xterm.
  const unlistenOut = await listen(`pty://output/${key}`, (evt) => {
    term.write(evt.payload);
    noteStdoutFromAgent(key);
    const ent = state.ptys.get(key);
    if (ent) ent.lastStdoutAt = Date.now();
  });
  const unlistenExit = await listen(`pty://exit/${key}`, (evt) => {
    const code = evt.payload?.code ?? '?';
    term.writeln(`\r\n\x1b[31m[pty exited code=${code}]\x1b[0m`);
    term.writeln(`\x1b[33mIf this happened immediately, the spawn args were rejected by claude. Check that the 'claude' CLI is on PATH and the --permission-mode flag is supported on this version.\x1b[0m`);
    const ent = state.ptys.get(key);
    if (ent) ent.exited = true;
  });

  // Stdin: forward xterm input.
  term.onData((data) => {
    invoke('pty_write', { args: { id: key, data } }).catch((e) => console.warn('pty_write', e));
    const ent = state.ptys.get(key);
    if (ent) ent.lastWriteAt = Date.now();
  });
  // TIOCSWINSZ on resize.
  term.onResize(({ cols, rows }) => {
    invoke('pty_resize', { args: { id: key, cols, rows } }).catch((e) => console.warn('pty_resize', e));
  });

  state.ptys.set(key, {
    term, fit, unlistens: [unlistenOut, unlistenExit],
    cwd, code, model, temp: !!opts.temp,
    lastStdoutAt: 0, lastWriteAt: 0, blockedReason: null, exited: false,
    spawnedAt: Date.now(),
  });
  if (opts.temp) state.tempAgents.add(key);

  // Spawn the actual claude process. Args:
  //   --model <model>                 per-agent /model selection
  //   --permission-mode acceptEdits   tiered-allowlist autonomy (internal trust)
  //   (project dir is the cwd; claude infers session there)
  // Crash-recovery resume path uses --resume <session_id>; passed via opts.resume.
  // opts.kickoff = onboarding kickoff prompt — auto-pasted after spawn (Lead path).
  const args = ['--model', model, '--permission-mode', 'acceptEdits'];
  if (opts.resume) args.push('--resume', opts.resume);
  // Spawn the actual claude process with composite key as pty id.
  await invoke('pty_spawn', {
    args: { id: key, command: 'claude', args, cwd, env: null, cols: term.cols, rows: term.rows },
  });
  // Persist the sticky model so this agent re-spawns with the same one.
  try { await invoke('models_set', { args: { code, model } }); state.stickyModels[code] = model; }
  catch (e) { console.warn('models_set failed', e); }
  // PH-134 onboarding — auto-paste the lead kickoff after pty boot. Two-second
  // delay so claude has finished its TUI splash before we shove the prompt in.
  if (opts.kickoff) {
    const ent = state.ptys.get(key);
    if (ent && !ent.kickoffFired) {
      ent.kickoffFired = true;
      // Wait for claude TUI to settle, then paste prompt + carriage return.
      // \r (CR) is what Enter sends in a real TTY — \n stays as a newline in
      // the input box and never submits.
      setTimeout(async () => {
        try {
          await invoke('pty_write', { args: { id: key, data: opts.kickoff } });
          // Small gap so the paste lands before the submit.
          await new Promise((r) => setTimeout(r, 250));
          await invoke('pty_write', { args: { id: key, data: '\r' } });
        } catch (e) {
          console.warn('kickoff paste failed', e);
        }
      }, 2500);
    }
  }
}

// PH-134 Phase 2 — wakeup prompt content.
// For an already-running agent (the v3 case), the wakeup is a short ping;
// the agent already loaded their full kickoff at spawn. Spawn-time kickoff
// content can be wired later by reading SaaS Architect/<AGENT>-kickoff.md
// (deferred — not strictly needed for Phase 2 smoke).
function buildWakeupPrompt({ ticketHumanId, reason }) {
  const ref = ticketHumanId ? ` (${ticketHumanId})` : '';
  return `\n\n[Yunomia wakeup — ${reason}${ref}] Check your queue.\n`;
}

async function onWakeup(payload) {
  const { agentCode, ticketHumanId, reason } = payload;
  // Wakeup goes to the agent running in the CURRENT project (not arbitrary instance).
  const key = ptyKey(state.selectedProject, agentCode);
  if (!state.ptys.has(key)) return;
  try {
    await invoke('pty_write', { args: { id: key, data: buildWakeupPrompt(payload) } });
    noteWakeupSent(key, ticketHumanId, reason);
    const ent = state.ptys.get(key);
    if (ent) ent.lastWriteAt = Date.now();
    console.info(`[wakeup] ${key} ← ${reason}`);
  } catch (err) {
    console.warn(`[wakeup] write failed for ${key}`, err);
  }
}

function maybeDisposeTempAgent(agentCode) {
  const key = ptyKey(state.selectedProject, agentCode);
  if (!state.tempAgents.has(key)) return;
  console.info(`[temp-agent] ${key} completed first task — auto-disposing in 30s`);
  state.tempAgents.delete(key);
  setTimeout(() => { void killPty(key); }, 30_000);
}

async function killPty(key) {
  const ent = state.ptys.get(key);
  if (!ent) return;
  try { await invoke('pty_kill', { args: { id: key } }); } catch { /* ignore */ }
  ent.unlistens.forEach((u) => u());
  ent.term.dispose();
  state.ptys.delete(key);
  state.tempAgents.delete(key);
  $$('#pane-tabs .tab').forEach((t) => { if (t.dataset.pane === key) t.remove(); });
  $$('#panes .pane').forEach((p) => { if (p.dataset.pane === key) p.remove(); });
  if (state.activePane === key) setActivePane('dashboard');
}

function tabEmoji(code) {
  const e = { LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };
  return e[code] || '⬛';
}

// Project picker — load + render at boot, drives spawn cwd + resume banner.
loadProjects();
renderProjectPicker();
bindProjectPicker();
bindAddProjectModal();
void refreshResumeBanner();

// Status state machine — derived per pty from stdout/write timing + flags.
function deriveStatus(ent) {
  if (!ent || ent.exited) return { state: 'idle', label: 'exited' };
  if (ent.blockedReason) return { state: 'blocked', label: ent.blockedReason };
  const now = Date.now();
  const sinceOut = ent.lastStdoutAt ? now - ent.lastStdoutAt : Infinity;
  const sinceIn  = ent.lastWriteAt  ? now - ent.lastWriteAt  : Infinity;
  if (sinceOut < 3_000) return { state: 'working', label: 'working' };
  if (sinceIn  < 20_000 && sinceOut > sinceIn) return { state: 'waiting', label: 'waiting' };
  if (sinceOut < 30_000) return { state: 'waiting', label: 'thinking' };
  return { state: 'idle', label: 'idle' };
}

// Render the agent rail. Project-scoped — shows ONLY agents that actually
// exist for this project (currently running ptys). No phantom 9-slot fleet.
// New agents arrive via Lead's brief-approval flow OR explicit + Spawn agent.
function renderAgentRail() {
  const root = document.getElementById('agent-rail');
  if (!root) return;
  const cwd = state.selectedProject;
  const running = visibleAgents();      // [{ key, ent }] for this project
  const head = `<div class="ar-head">
    <span>Agents</span>
    <button id="ar-add" class="ar-add" title="Spawn agent">+</button>
  </div>`;
  if (!running.length) {
    root.innerHTML = `${head}<div class="ar-empty">No agents in this project yet. Click <b>+</b> to spawn one.</div>`;
  } else {
    const list = running.map(({ key, ent }) => {
      const code = ent.code;
      const { state: stat, label } = deriveStatus(ent);
      return `<li class="ar-row ar-${stat}" data-code="${code}" data-key="${key}">
        <span class="ar-emoji">${tabEmoji(code)}</span>
        <div class="ar-mid">
          <span class="ar-code">${code}</span>
          <span class="ar-label">${escapeHtml(label)}</span>
        </div>
        <span class="ar-dot" data-status="${stat}"></span>
        <button class="ar-action" data-act="open" title="Open tab">↗</button>
        <button class="ar-action ar-kill" data-act="kill" title="Kill">✕</button>
      </li>`;
    }).join('');
    root.innerHTML = `${head}<ul class="ar-list">${list}</ul>`;
  }
  root.querySelector('#ar-add')?.addEventListener('click', () => {
    document.getElementById('spawn-agent')?.click();
  });
  root.querySelectorAll('.ar-row').forEach((row) => {
    const key = row.dataset.key;
    row.querySelector('[data-act="open"]')?.addEventListener('click', (e) => { e.stopPropagation(); setActivePane(key); });
    row.querySelector('[data-act="kill"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Kill ${row.dataset.code}?`)) return;
      void killPty(key);
    });
  });
}

// Update tab status dots + agent rail every second.
function statusLoopTick() {
  for (const [key, ent] of state.ptys.entries()) {
    const tab = document.querySelector(`#pane-tabs .tab[data-pane="${CSS.escape(key)}"] .status-dot`);
    if (tab) tab.dataset.status = deriveStatus(ent).state;
  }
  renderAgentRail();
}
setInterval(statusLoopTick, 1000);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Project view switcher — onboarding (no project, or phase=onboarding) vs
// active (full kanban). Re-renders on project change + after brief approval.
async function renderProjectView() {
  applyProjectVisibility();
  const onbRoot    = document.getElementById('onboarding-root');
  const activeRoot = document.getElementById('dashboard-active');
  const spawnBtn   = document.getElementById('spawn-agent');
  const cwd = state.selectedProject;
  if (!cwd) {
    if (onbRoot)   { onbRoot.hidden = false; onbRoot.innerHTML = `<div class="onb-empty">Pick or add a project (top bar) to begin.</div>`; }
    if (activeRoot) activeRoot.hidden = true;
    if (spawnBtn)   spawnBtn.hidden = true;     // no project → no manual spawn
    return;
  }
  const { state: projState, brief } = await loadOnboardingForProject(cwd);
  if (projState.phase !== 'active') {
    if (activeRoot) activeRoot.hidden = true;
    if (onbRoot)    onbRoot.hidden = false;
    if (spawnBtn)   spawnBtn.hidden = true;     // onboarding spawns Lead via the onb CTA
    const leadKey = ptyKey(cwd, 'LEAD');
    const leadRunning = state.ptys.has(leadKey);
    renderOnboardingView({
      container: onbRoot,
      cwd,
      state: projState,
      brief,
      spawnAgent: (code, model, cwd, opts) => spawnAgent(code, model, cwd, opts),
      onApproved: () => renderProjectView(),
      leadRunning,
    });
  } else {
    if (onbRoot)    onbRoot.hidden = true;
    if (activeRoot) activeRoot.hidden = false;
    if (spawnBtn)   spawnBtn.hidden = false;    // active → manual spawn allowed
    initKanban({
      cwd,
      onWakeup: (payload) => onWakeup(payload),
    });
  }
}

// Expose so the project picker triggers re-render too.
window.__renderProjectView = renderProjectView;
void renderProjectView();

bindUi();

// PH-134 Phase 2 — bridge to MC + auto-compact orchestrator.
void initCompactOrchestrator();
startMcBridge({
  getRunningAgents: () => Array.from(state.ptys.keys()),
  onWakeup,
  onTaskBoundary: (evt) => {
    noteTaskBoundary(evt);
    maybeDisposeTempAgent(evt.agentCode);
  },
});

// PH-134 Phase 3 — heartbeat (L0 mechanical + L1 hourly CEO).
startHeartbeat({
  getRunningAgents: () => Array.from(state.ptys.keys()),
  rewakeAgent: (code, ticketHumanId, reason) => onWakeup({ agentCode: code, ticketHumanId, reason }),
});

// PH-134 Phase 3 — crash recovery. Enumerates recent Claude sessions for the
// currently-selected project root and renders a banner offering Resume.
async function refreshResumeBanner() {
  document.querySelectorAll('.resume-banner').forEach((b) => b.remove());
  const cwd = state.selectedProject;
  if (!cwd) return;
  let sessions = [];
  try {
    sessions = await invoke('enumerate_sessions', { args: { cwd, limit: 8 } }) || [];
  } catch (err) { console.warn('enumerate_sessions failed', err); return; }
  if (!sessions.length) return;
  const recent = sessions.slice(0, 3);
  const html = recent.map((s) => {
    const when = s.modified ? new Date(s.modified).toLocaleString() : '?';
    return `<button class="resume-btn" data-sid="${s.session_id}">Resume ${s.session_id.slice(0,8)} · ${when}</button>`;
  }).join(' ');
  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML = `<span>Recent sessions in <b>${projectLabel(cwd)}</b>:</span> ${html} <button class="resume-dismiss" type="button">✕</button>`;
  document.body.insertBefore(banner, document.body.firstChild);
  banner.querySelectorAll('.resume-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const sid = b.dataset.sid;
      const code = prompt('Agent code to spawn this session as (e.g. CEO, QA):', 'CEO');
      if (!code) return;
      banner.remove();
      const model = state.stickyModels?.[code] || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
      await spawnAgent(code, model, cwd, { resume: sid });
    });
  });
  banner.querySelector('.resume-dismiss').addEventListener('click', () => banner.remove());
}

// Expose for console debugging during dogfood.
window.yunomia = { state, firePreCompact };
