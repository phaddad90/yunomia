// Yunomia v3 frontend — pane manager + xterm.js mounting per pty.
// Conventions:
//   • Each pty has a stable string id (typically the AGENT code: "CEO", "QA").
//   • Tauri events: `pty://output/<id>` carries stdout/stderr; `pty://exit/<id>` fires on child exit.
//   • Resize event triggers TIOCSWINSZ via `pty_resize` invoke.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const AGENT_MODELS_DEFAULT = {
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
  ptys: new Map(),     // id → { term, fit, unlistens: [] }
  activePane: 'dashboard',
};

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

function openSpawnModal()  { $('#spawn-modal').classList.remove('hidden'); }
function closeSpawnModal() { $('#spawn-modal').classList.add('hidden'); }

async function submitSpawn() {
  const code = $('#spawn-code').value;
  const model = $('#spawn-model').value || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  const cwd = ($('#spawn-cwd').value || '/Users/peter/Desktop/Project Eunomia').trim();
  closeSpawnModal();
  try {
    await spawnAgent(code, model, cwd);
  } catch (err) {
    console.error('spawn failed', err);
    alert('Spawn failed: ' + (err?.message || err));
  }
}

// PH-134 — spawn one agent in a new pty pane. Real `claude` CLI in pty.
async function spawnAgent(code, model, cwd) {
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

  state.ptys.set(code, { term, fit, unlistens: [unlistenOut, unlistenExit] });

  // Spawn the actual claude process. Args:
  //   --model <model>            per-agent /model selection (PH-134 Phase 2)
  //   (project dir is the cwd; claude infers session there)
  const args = ['--model', model];
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
  const e = { CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };
  return e[code] || '⬛';
}

bindUi();
