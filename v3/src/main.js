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
  ptys: new Map(),         // id → { term, fit, unlistens: [], cwd, model, temp }
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
      const next = prompt('Project root absolute path:', state.selectedProject || '/Users/peter/Desktop/');
      if (next && next.trim()) {
        const path = next.trim().replace(/\/$/, '');
        if (!state.projects.includes(path)) state.projects.push(path);
        state.selectedProject = path;
        saveProjects();
        renderProjectPicker();
        void refreshResumeBanner();
        void setKanbanProject(path);
      } else {
        renderProjectPicker();   // restore previous selection
      }
      return;
    }
    state.selectedProject = sel.value;
    saveProjects();
    void refreshResumeBanner();
    void window.__renderProjectView?.();
  });
}

function setActivePane(id) {
  state.activePane = id;
  $$('#pane-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === id));
  $$('#panes .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
  // Re-fit any xterm in the activated pane (xterm needs a layout pass after display change).
  const ent = state.ptys.get(id);
  if (ent) requestAnimationFrame(() => ent.fit.fit());
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

// PH-134 — spawn one agent in a new pty pane. Real `claude` CLI in pty.
async function spawnAgent(code, model, cwd, opts = {}) {
  if (state.ptys.has(code)) {
    setActivePane(code);
    return;
  }
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.pane = code;
  tabBtn.innerHTML = `<span class="tab-emoji">${tabEmoji(code)}</span> ${code} <span class="tab-close" title="Kill" data-kill="${code}">×</span>`;
  tabBtn.addEventListener('click', (e) => {
    if (e.target.dataset.kill) { void killPty(code); return; }
    setActivePane(code);
  });
  $('#pane-tabs').appendChild(tabBtn);

  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.pane = code;
  const termWrap = document.createElement('div');
  termWrap.className = 'term-wrap';
  pane.appendChild(termWrap);
  $('#panes').appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#0b0b0c', foreground: '#e8e8e8', cursor: '#d93a00' },
    convertEol: true,
    scrollback: 10_000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termWrap);
  fit.fit();

  setActivePane(code);

  // Stream stdout from the pty into xterm.
  const unlistenOut = await listen(`pty://output/${code}`, (evt) => {
    term.write(evt.payload);
    noteStdoutFromAgent(code);   // PH-134 Phase 3 — heartbeat L0 signal
  });
  const unlistenExit = await listen(`pty://exit/${code}`, (evt) => {
    term.writeln(`\r\n\x1b[31m[pty exited code=${evt.payload?.code ?? '?'}]\x1b[0m`);
  });

  // Stdin: forward xterm input + emit any /pty-audit hook (PH-134 Phase 3).
  term.onData((data) => {
    invoke('pty_write', { args: { id: code, data } }).catch((e) => console.warn('pty_write', e));
  });
  // PH-134 Q1 — wire TIOCSWINSZ on resize.
  term.onResize(({ cols, rows }) => {
    invoke('pty_resize', { args: { id: code, cols, rows } }).catch((e) => console.warn('pty_resize', e));
  });

  state.ptys.set(code, { term, fit, unlistens: [unlistenOut, unlistenExit], cwd, model, temp: !!opts.temp });
  if (opts.temp) state.tempAgents.add(code);

  // Spawn the actual claude process. Args:
  //   --model <model>                 per-agent /model selection
  //   --permission-mode acceptEdits   tiered-allowlist autonomy (internal trust)
  //   (project dir is the cwd; claude infers session there)
  // Crash-recovery resume path uses --resume <session_id>; passed via opts.resume.
  // opts.kickoff = onboarding kickoff prompt — auto-pasted after spawn (Lead path).
  const args = ['--model', model, '--permission-mode', 'acceptEdits'];
  if (opts.resume) args.push('--resume', opts.resume);
  await invoke('pty_spawn', {
    args: {
      id: code,
      command: 'claude',
      args,
      cwd,
      env: null,
      cols: term.cols,
      rows: term.rows,
    },
  });
  // Persist the sticky model so this agent re-spawns with the same one.
  try { await invoke('models_set', { args: { code, model } }); state.stickyModels[code] = model; }
  catch (e) { console.warn('models_set failed', e); }
  // PH-134 onboarding — auto-paste the lead kickoff after pty boot. Two-second
  // delay so claude has finished its TUI splash before we shove the prompt in.
  if (opts.kickoff) {
    setTimeout(() => {
      void writeToAgent(code, opts.kickoff + '\n').catch((e) => console.warn('kickoff paste failed', e));
    }, 2000);
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
  if (!state.ptys.has(agentCode)) return;   // agent not running in this shell
  try {
    await writeToAgent(agentCode, buildWakeupPrompt(payload));
    noteWakeupSent(agentCode, ticketHumanId, reason);   // heartbeat L0 input
    console.info(`[wakeup] ${agentCode} ← ${reason}`);
  } catch (err) {
    console.warn(`[wakeup] write failed for ${agentCode}`, err);
  }
}

// PH-134 Phase 3 — temp-agent auto-dispose hook. When a flagged temp agent
// posts their first task-boundary verdict, kill their pty after a short grace.
function maybeDisposeTempAgent(agentCode) {
  if (!state.tempAgents.has(agentCode)) return;
  console.info(`[temp-agent] ${agentCode} completed first task — auto-disposing in 30s`);
  state.tempAgents.delete(agentCode);
  setTimeout(() => { void killPty(agentCode); }, 30_000);
}

async function killPty(code) {
  const ent = state.ptys.get(code);
  if (!ent) return;
  try { await invoke('pty_kill', { args: { id: code } }); } catch { /* ignore */ }
  ent.unlistens.forEach((u) => u());
  ent.term.dispose();
  state.ptys.delete(code);
  $$('#pane-tabs .tab').forEach((t) => { if (t.dataset.pane === code) t.remove(); });
  $$('#panes .pane').forEach((p) => { if (p.dataset.pane === code) p.remove(); });
  if (state.activePane === code) setActivePane('dashboard');
}

function tabEmoji(code) {
  const e = { LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };
  return e[code] || '⬛';
}

// Project picker — load + render at boot, drives spawn cwd + resume banner.
loadProjects();
renderProjectPicker();
bindProjectPicker();
void refreshResumeBanner();

// Project view switcher — onboarding (no project, or phase=onboarding) vs
// active (full kanban). Re-renders on project change + after brief approval.
async function renderProjectView() {
  const onbRoot   = document.getElementById('onboarding-root');
  const activeRoot = document.getElementById('dashboard-active');
  const cwd = state.selectedProject;
  if (!cwd) {
    if (onbRoot)   { onbRoot.hidden = false; onbRoot.innerHTML = `<div class="onb-empty">Pick or add a project (top bar) to begin.</div>`; }
    if (activeRoot) activeRoot.hidden = true;
    return;
  }
  const { state: projState, brief } = await loadOnboardingForProject(cwd);
  if (projState.phase !== 'active') {
    if (activeRoot) activeRoot.hidden = true;
    if (onbRoot)    onbRoot.hidden = false;
    renderOnboardingView({
      container: onbRoot,
      cwd,
      state: projState,
      brief,
      spawnAgent: (code, model, cwd, opts) => spawnAgent(code, model, cwd, opts),
      onApproved: () => renderProjectView(),
    });
  } else {
    if (onbRoot)    onbRoot.hidden = true;
    if (activeRoot) activeRoot.hidden = false;
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
