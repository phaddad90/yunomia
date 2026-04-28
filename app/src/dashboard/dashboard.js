// PrintPepper Mission Control — vanilla JS, no framework.
// One brain. Many hands. No waste.

const AGENT_EMOJI = { SA: '🟧', AD: '🟦', WA: '🟪', DA: '🟨', QA: '🟥', WD: '🌐', CEO: '🎯', TA: '🛠' };
const COLUMNS = [
  { id: 'backlog',     label: 'Backlog' },
  { id: 'triage',      label: 'Triage' },
  { id: 'assigned',    label: 'Assigned' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review',   label: 'In Review' },
  { id: 'done',        label: 'Done' },
  { id: 'released',    label: 'Released' },
];

const state = {
  me: 'TA',
  tickets: [],
  agents: [],
  filters: { audience: '', assignee: '', q: '' },
  activity: [],
  ws: null,
  refreshTimer: null,
  selectedTicketId: null,
};

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ─── Boot ───

(async function boot() {
  try {
    const me = await fetch('/api/me').then((r) => r.json());
    state.me = me.agentCode || 'TA';
    $('#who-agent').textContent = `${AGENT_EMOJI[state.me] || ''} ${state.me}`;
  } catch { /* keep default */ }

  bindUi();
  connectWs();
  await refreshBoard();
  await refreshInbox();
})();

// ─── UI bindings ───

function bindUi() {
  // Tab switcher
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      const which = btn.dataset.tab;
      $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${which}`));
      if (which === 'reports') renderReports();
    });
  });

  $('#refresh').addEventListener('click', refreshBoard);
  $('#filter-audience').addEventListener('change', (e) => { state.filters.audience = e.target.value; renderBoard(); });
  $('#filter-assignee').addEventListener('change', (e) => { state.filters.assignee = e.target.value; renderBoard(); });
  $('#filter-q').addEventListener('input', debounce((e) => { state.filters.q = e.target.value.toLowerCase(); renderBoard(); }, 200));

  // Note form
  $('#note-form').addEventListener('submit', (e) => { e.preventDefault(); submitNote(); });
  $('#btn-screenshot').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', handleFileAttach);
  $('#btn-voice').addEventListener('click', toggleVoice);

  // Inbox pill + modal
  $('#inbox-pill').addEventListener('click', openInboxModal);
  $('#inbox-mark-all').addEventListener('click', markAllInboxProcessed);
  $$('#inbox-modal [data-close="1"]').forEach((el) => el.addEventListener('click', closeInboxModal));

  // Side panel
  $('#side-close').addEventListener('click', closeSidePanel);
  $('#side-copy').addEventListener('click', copyPromptForSelected);
  $('#side-start').addEventListener('click', () => transitionSelected('start'));
  $('#side-handoff').addEventListener('click', () => transitionSelected('handoff'));
  $('#side-done').addEventListener('click', () => transitionSelected('done'));

  // Drag screenshots into the body (textarea)
  const note = $('#note-body');
  note.addEventListener('paste', handlePaste);
  ['dragenter','dragover'].forEach((ev) => note.addEventListener(ev, (e) => { e.preventDefault(); note.style.borderColor = 'var(--pepper)'; }));
  ['dragleave','drop'].forEach((ev) => note.addEventListener(ev, () => { note.style.borderColor = ''; }));
  note.addEventListener('drop', handleDrop);
}

// ─── WebSocket ───

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('open', () => setLive(true));
  ws.addEventListener('close', () => { setLive(false); setTimeout(connectWs, 2000); });
  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'tickets_changed') { refreshBoard(); refreshOpenTicket(); }
      else if (msg.type === 'audit_event') prependActivity(msg.data);
      else if (msg.type === 'inbox_changed') updateInboxPill(msg.data.unprocessed);
      else if (msg.type === 'toast') toast(msg.data.text, msg.data.kind);
    } catch { /* ignore */ }
  });
}

function setLive(on) {
  $('#live-dot').dataset.state = on ? 'on' : 'off';
  $('#live-label').textContent = on ? 'live' : 'reconnecting…';
}

// ─── Refresh ───

let refreshing = false;
async function refreshBoard() {
  if (refreshing) return;
  refreshing = true;
  try {
    const params = new URLSearchParams();
    if (state.filters.audience) params.set('audience', state.filters.audience);
    if (state.filters.assignee) params.set('assignee', state.filters.assignee);
    const r = await fetch('/api/board/tickets?' + params.toString());
    if (!r.ok) throw new Error(`board fetch ${r.status}`);
    const data = await r.json();
    state.tickets = data.tickets || [];
    state.agents = data.agents || [];
    renderAll();
  } catch (err) {
    toast(String(err.message || err), 'error');
  } finally {
    refreshing = false;
  }
}

function renderAll() {
  renderAgents();
  renderStats();
  renderBundle();
  renderBoard();
  renderInbox();
}

// ─── Agents (left rail) ───

function renderAgents() {
  const ul = $('#agent-list');
  ul.innerHTML = '';
  for (const a of state.agents) {
    const li = document.createElement('li');
    li.className = 'agent-card';
    li.innerHTML = `
      <span class="agent-emoji">${a.emoji}</span>
      <span class="agent-code">${a.code}</span>
      <span class="agent-meta">${a.current ? `${a.current.ticket_human_id} · ${a.current.status.replace('_',' ')}` : 'idle'}</span>
      <span class="light" data-state="${a.light}" title="${a.light}"></span>
    `;
    li.addEventListener('click', () => openSoul(a.code));
    ul.appendChild(li);
  }
}

// ─── Stats ───

function renderStats() {
  const open = state.tickets.filter((t) => ['assigned','in_progress'].includes(t.status)).length;
  const review = state.tickets.filter((t) => t.status === 'in_review').length;
  const triage = state.tickets.filter((t) => ['triage','backlog'].includes(t.status)).length;
  const today = todayIso();
  const doneToday = state.tickets.filter((t) => t.status === 'done' && (t.updated_at || '').startsWith(today)).length;
  $('#stat-open').textContent = open;
  $('#stat-review').textContent = review;
  $('#stat-triage').textContent = triage;
  $('#stat-done').textContent = doneToday;
}

function renderBundle() {
  const ul = $('#deploy-bundle');
  const ready = state.tickets.filter((t) => t.status === 'done' && t.audience === 'admin');
  ul.innerHTML = '';
  if (!ready.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tickets queued for deploy';
    ul.appendChild(li);
    return;
  }
  for (const t of ready.slice(0, 6)) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${t.ticket_human_id}</span><span>${(t.assignee_agent || '—')}</span>`;
    li.addEventListener('click', () => openTicket(t.id));
    ul.appendChild(li);
  }
}

// ─── Board (kanban) ───

function renderBoard() {
  const root = $('#kanban');
  root.innerHTML = '';
  const filtered = state.tickets.filter(matchFilters);
  for (const col of COLUMNS) {
    const cards = filtered.filter((t) => t.status === col.id);
    const colEl = document.createElement('div');
    colEl.className = 'col';
    colEl.innerHTML = `<div class="col-head"><span>${col.label}</span><span class="count">${cards.length}</span></div>`;
    for (const t of cards) colEl.appendChild(renderTicketCard(t));
    root.appendChild(colEl);
  }
}

function matchFilters(t) {
  const f = state.filters;
  if (f.audience && t.audience !== f.audience) return false;
  if (f.assignee && t.assignee_agent !== f.assignee) return false;
  if (f.q) {
    const hay = (t.title + ' ' + (t.body_md || '') + ' ' + t.ticket_human_id).toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function renderTicketCard(t) {
  const div = document.createElement('div');
  div.className = 'ticket';
  div.dataset.id = t.id;
  div.innerHTML = `
    <div class="ticket-head">
      <span class="ticket-id">${t.ticket_human_id}</span>
      <span class="ticket-assignee">${t.assignee_agent ? AGENT_EMOJI[t.assignee_agent] || '' : ''} ${t.assignee_agent || ''}</span>
    </div>
    <div class="ticket-title">${escapeHtml(t.title)}</div>
    <div class="ticket-foot">
      <span class="ticket-pill ${t.audience}">${t.audience}</span>
      <span class="ticket-pill ${t.type}">${t.type}</span>
    </div>
  `;
  div.addEventListener('click', () => openTicket(t.id));
  return div;
}

// ─── Inbox / Activity / Reports ───

function renderInbox() {
  const triage = state.tickets.filter((t) => t.status === 'triage' || (t.assignee_agent === 'CEO' && t.status !== 'done' && t.status !== 'released'));
  $('#inbox-count').textContent = triage.length;
  fillTicketList($('#inbox-quick'), triage.slice(0, 8));
  fillTicketList($('#my-inbox'), state.tickets.filter((t) => t.assignee_agent === state.me && ['assigned','in_progress','in_review'].includes(t.status)));
}

function fillTicketList(ul, items) {
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'ticket-pill admin';
    li.style.padding = '6px 10px';
    li.textContent = 'Nothing here.';
    ul.appendChild(li);
    return;
  }
  for (const t of items) ul.appendChild(renderTicketCard(t));
}

function prependActivity(row) {
  state.activity.unshift(row);
  state.activity = state.activity.slice(0, 100);
  const ul = $('#activity-feed');
  if (!ul) return;
  ul.innerHTML = '';
  for (const r of state.activity) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="when">${formatTime(r.created_at)}</span>
      <span class="what">${escapeHtml(formatAction(r))}</span>
      <span class="who">${escapeHtml(formatActor(r))}</span>
    `;
    ul.appendChild(li);
  }
}

function formatAction(row) {
  const action = row.action.replace('ticket.', '');
  const target = row.target || (row.details && row.details.id) || '';
  return `${action} → ${target}`;
}
function formatActor(row) {
  if (row.actor_kind === 'agent' && row.details && row.details.agent_id) return AGENT_EMOJI[row.details.agent_id] + ' ' + row.details.agent_id;
  return row.actor_kind || '';
}

function renderReports() {
  const today = todayIso();
  const done = state.tickets.filter((t) => t.status === 'done' && (t.updated_at || '').startsWith(today));
  const released = state.tickets.filter((t) => t.status === 'released' && (t.released_at || t.updated_at || '').startsWith(today));
  const triage = state.tickets.filter((t) => t.status === 'triage');
  const ul = $('#report-summary');
  ul.innerHTML = '';
  for (const [label, count] of [
    ['Done today', done.length],
    ['Released today', released.length],
    ['Currently triaging', triage.length],
    ['Tracked tickets total', state.tickets.length],
  ]) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${count}</b> &nbsp; ${label}`;
    li.style.padding = '8px 0';
    li.style.borderBottom = '1px dashed var(--border)';
    ul.appendChild(li);
  }
}

// ─── Side panel ───

async function openTicket(id) {
  state.selectedTicketId = id;
  const panel = $('#side-panel');
  panel.classList.remove('hidden');
  $('#side-body').textContent = 'Loading…';
  try {
    const r = await fetch(`/api/board/tickets/${id}`).then((r) => r.json());
    const t = r.ticket;
    $('#side-id').textContent = t.ticket_human_id;
    $('#side-status').textContent = t.status.replace('_', ' ');
    $('#side-status').className = 'status-pill ' + t.status;
    $('#side-body').innerHTML = renderTicketDetail(t, r.audit || [], r.comments || []);
  } catch (err) {
    $('#side-body').textContent = 'Failed to load: ' + (err.message || err);
  }
}

// Re-fetch the open ticket (silently — keep scroll/focus, no flash) when WS
// signals board-side activity. Dashboard already calls refreshBoard()
// for the kanban; this keeps the side panel synced for the comms layer.
async function refreshOpenTicket() {
  const id = state.selectedTicketId;
  if (!id) return;
  try {
    const r = await fetch(`/api/board/tickets/${id}`).then((r) => r.json());
    const t = r.ticket;
    $('#side-id').textContent = t.ticket_human_id;
    $('#side-status').textContent = t.status.replace('_', ' ');
    $('#side-status').className = 'status-pill ' + t.status;
    $('#side-body').innerHTML = renderTicketDetail(t, r.audit || [], r.comments || []);
  } catch { /* silent */ }
}

function closeSidePanel() {
  $('#side-panel').classList.add('hidden');
  state.selectedTicketId = null;
}

function renderTicketDetail(t, audit, commentsArr) {
  const refs = (() => { try { return JSON.parse(t.references_json || '[]'); } catch { return []; } })();
  const refList = refs.length ? `<h4>References</h4><ul>${refs.map((r) => `<li>${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</li>`).join('')}</ul>` : '';
  // PH-051: comments come from {ticket, audit, comments} now. Oldest-first
  // matches the API order so verdicts read top-to-bottom in chronological
  // order (the comm layer relies on this — readers should see SA → AD → QA
  // top-down, not the reverse).
  const list = (commentsArr || []).slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const comments = list.map((c) => `
    <div class="comment">
      <div class="who">${escapeHtml(c.author_label || c.author_kind || '')} · ${formatTime(c.created_at)}</div>
      ${escapeHtml(c.body_md || '')}
    </div>
  `).join('');
  return `
    <h2 style="margin:0 0 8px">${escapeHtml(t.title)}</h2>
    <div style="font-size:12px;color:var(--text-mid);margin-bottom:14px">
      ${t.assignee_agent ? AGENT_EMOJI[t.assignee_agent] + ' ' + t.assignee_agent : 'Unassigned'} ·
      ${t.audience} · ${t.type}
    </div>
    <pre style="white-space:pre-wrap;background:var(--surface-2);padding:12px;border-radius:8px">${escapeHtml(t.body_md || '')}</pre>
    ${refList}
    <div class="comments">
      <h4>Comments (${list.length})</h4>
      ${comments || '<div style="color:var(--text-low);font-size:12px">No comments yet.</div>'}
    </div>
  `;
}

async function copyPromptForSelected() {
  if (!state.selectedTicketId) return;
  try {
    const r = await fetch(`/api/copy-prompt/${state.selectedTicketId}`).then((r) => r.json());
    await navigator.clipboard.writeText(r.prompt || '');
    toast('Prompt copied to clipboard', 'success');
  } catch (err) {
    toast('Copy failed: ' + (err.message || err), 'error');
  }
}

async function transitionSelected(action) {
  if (!state.selectedTicketId) return;
  try {
    const r = await fetch(`/api/board/tickets/${state.selectedTicketId}/${action}`, { method: 'POST' });
    if (!r.ok) throw new Error(`${action} ${r.status}`);
    toast(`Moved to ${action}`, 'success');
    await openTicket(state.selectedTicketId);
    refreshBoard();
  } catch (err) {
    toast(String(err.message || err), 'error');
  }
}

async function openSoul(code) {
  const panel = $('#side-panel');
  panel.classList.remove('hidden');
  $('#side-id').textContent = code;
  $('#side-status').textContent = 'soul';
  $('#side-status').className = 'status-pill';
  $('#side-body').textContent = 'Loading…';
  try {
    const r = await fetch(`/api/agents/${code}/soul`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      $('#side-body').innerHTML = `<div style="color:var(--text-mid)">${escapeHtml(err.error || 'Soul file not available yet.')}</div>`;
      return;
    }
    const md = await r.text();
    $('#side-body').innerHTML = `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
  } catch (err) {
    $('#side-body').textContent = 'Failed: ' + (err.message || err);
  }
}

// ─── Drop a Note ───

const noteAttachments = [];

async function submitNote() {
  const body = $('#note-body').value.trim();
  if (!body) { toast('Add a note first', 'error'); return; }
  let composedBody = body;
  if (noteAttachments.length) {
    composedBody += '\n\n---\nAttachments:\n' + noteAttachments.map((a, i) => `- screenshot-${i + 1}.${a.ext} (${Math.round(a.size / 1024)}KB) — image data attached locally; re-attach if relayed`).join('\n');
  }
  try {
    const r = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: $('#note-title').value.trim(),
        body: composedBody,
        audience: $('#note-audience').value,
        type: $('#note-type').value,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `note ${r.status}`);
    }
    const data = await r.json();
    toast(`Created ${data.ticket?.ticket_human_id || 'ticket'}`, 'success');
    $('#note-title').value = '';
    $('#note-body').value = '';
    noteAttachments.length = 0;
    renderAttachments();
    refreshBoard();
  } catch (err) {
    toast(String(err.message || err), 'error');
  }
}

function handleFileAttach(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  attachFile(f);
  e.target.value = '';
}
async function attachFile(file) {
  const data = await fileToBase64(file);
  noteAttachments.push({ name: file.name, ext: (file.name.split('.').pop() || 'png').toLowerCase(), size: file.size, data });
  renderAttachments();
}
function renderAttachments() {
  const div = $('#note-attachments');
  div.innerHTML = '';
  noteAttachments.forEach((a, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'att';
    wrap.innerHTML = `<img class="thumb" src="${a.data}" alt="${a.name}" /><button class="x" type="button" data-idx="${idx}">×</button>`;
    wrap.querySelector('.x').addEventListener('click', () => { noteAttachments.splice(idx, 1); renderAttachments(); });
    div.appendChild(wrap);
  });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function handlePaste(e) {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) attachFile(f);
    }
  }
}
function handleDrop(e) {
  e.preventDefault();
  const files = e.dataTransfer?.files || [];
  for (const f of files) if (f.type.startsWith('image/')) attachFile(f);
}

// ─── Voice (Web Speech API) ───

let recog = null;
let recogActive = false;
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Speech recognition not supported in this browser', 'error'); return; }
  if (recogActive) { recog && recog.stop(); return; }
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = 'en-GB';
  let baseline = $('#note-body').value;
  recog.onresult = (e) => {
    let interim = '', finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t; else interim += t;
    }
    if (finalText) baseline = (baseline + ' ' + finalText).trim();
    $('#note-body').value = (baseline + (interim ? ' ' + interim : '')).trimStart();
  };
  recog.onerror = (e) => { toast('Voice: ' + e.error, 'error'); recogActive = false; $('#btn-voice').classList.remove('btn-voice-on'); };
  recog.onend = () => { recogActive = false; $('#btn-voice').classList.remove('btn-voice-on'); };
  recog.start();
  recogActive = true;
  $('#btn-voice').classList.add('btn-voice-on');
}

// ─── CEO inbox pill + modal ───

async function refreshInbox() {
  try {
    const r = await fetch('/api/inbox').then((r) => r.json());
    state.inbox = r;
    updateInboxPill(r.unprocessed || 0);
    if (!$('#inbox-modal').classList.contains('hidden')) renderInboxModal();
  } catch { /* offline ok */ }
}

function updateInboxPill(n) {
  const pill = $('#inbox-pill');
  pill.hidden = false;
  pill.dataset.zero = n > 0 ? '0' : '1';
  $('#inbox-pill-count').textContent = n;
  if (n > 0) document.title = `(${n}) Mission Control`;
  else document.title = 'Mission Control — PrintPepper';
}

async function openInboxModal() {
  await refreshInbox();
  renderInboxModal();
  $('#inbox-modal').classList.remove('hidden');
}

function closeInboxModal() {
  $('#inbox-modal').classList.add('hidden');
}

function renderInboxModal() {
  const data = state.inbox || { entries: [], unprocessed: 0 };
  $('#inbox-modal-count').textContent = `${data.unprocessed} unprocessed`;
  const ul = $('#inbox-list');
  ul.innerHTML = '';
  if (!data.entries || !data.entries.length) {
    const li = document.createElement('li');
    li.className = 'inbox-row processed';
    li.innerHTML = `<div><div class="summary">No events yet — Drop a Note or wait for board activity.</div></div>`;
    ul.appendChild(li);
    return;
  }
  for (const e of data.entries) {
    const li = document.createElement('li');
    li.className = 'inbox-row' + (e.processed ? ' processed' : '');
    li.innerHTML = `
      <div>
        <div class="summary">${escapeHtml(e.summary)}</div>
        <div class="meta">${escapeHtml(e.event)} · ${formatTime(e.ts)} · ${escapeHtml(e.source)}${e.actor ? ' · ' + escapeHtml(e.actor) : ''}</div>
      </div>
      <div>
        ${e.ticket_id ? `<button class="btn-ghost" data-open="${e.ticket_id}" type="button">Open</button>` : ''}
        ${e.processed ? '<span class="ticket-pill admin">processed</span>' : `<button class="btn-secondary" data-mark="${e.delivery_id}" type="button">Mark processed</button>`}
      </div>
    `;
    ul.appendChild(li);
  }
  $$('#inbox-list [data-mark]').forEach((b) => b.addEventListener('click', () => markInboxProcessed([b.dataset.mark])));
  $$('#inbox-list [data-open]').forEach((b) => b.addEventListener('click', () => { closeInboxModal(); openTicket(b.dataset.open); }));
}

async function markInboxProcessed(ids) {
  if (!ids.length) return;
  try {
    const r = await fetch('/api/inbox/processed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_ids: ids }),
    });
    if (!r.ok) throw new Error(`mark ${r.status}`);
    await refreshInbox();
  } catch (err) {
    toast(String(err.message || err), 'error');
  }
}

async function markAllInboxProcessed() {
  const data = state.inbox || { entries: [] };
  const ids = (data.entries || []).filter((e) => !e.processed).map((e) => e.delivery_id);
  if (!ids.length) return;
  await markInboxProcessed(ids);
}

// ─── Helpers ───

function toast(text, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
