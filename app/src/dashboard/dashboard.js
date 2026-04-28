// PrintPepper Mission Control — vanilla JS, no framework.
// One brain. Many hands. No waste.

const AGENT_EMOJI = { SA: '🟧', AD: '🟦', WA: '🟪', DA: '🟨', QA: '🟥', WD: '🌐', CEO: '🎯', TA: '🛠', PETER: '🎩' };
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
  selectedTicketComments: [],
  seenEventIds: new Set(),    // dedupe granular WS events between local-write and audit-poll paths
  presence: {},                // agent_code → AgentPresence
};

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ─── Boot ───

(async function boot() {
  try {
    const me = await fetch('/api/me').then((r) => r.json());
    state.me = me.agentCode || 'TA';
    populateIdentityDropdown(me.allowed || ['SA','AD','WA','DA','QA','WD','CEO','TA'], state.me);
  } catch { /* keep default */ }

  bindUi();
  connectWs();
  await refreshBoard();
  await refreshInbox();
  await refreshCost();
  await refreshPresence();
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

  // Identity switcher
  $('#who-select').addEventListener('change', (e) => switchIdentity(e.target.value));

  // Cost pill + modal
  $('#cost-pill').addEventListener('click', openCostModal);
  $$('#cost-modal [data-close="1"]').forEach((el) => el.addEventListener('click', closeCostModal));

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
      switch (msg.type) {
        case 'ticket.created':   if (markSeen(msg.data?.event_id)) handleTicketCreated(msg.data.ticket); break;
        case 'ticket.changed':   if (markSeen(msg.data?.event_id)) handleTicketChanged(msg.data); break;
        case 'comment.added':    if (markSeen(msg.data?.event_id)) handleCommentAdded(msg.data); break;
        case 'comment.deleted':  if (markSeen(msg.data?.event_id)) handleCommentDeleted(msg.data); break;
        case 'tickets_changed':  /* coarse fallback — only fires the full refetch if a granular handler hasn't already covered it within the last 2s */
                                 maybeFullRefresh(msg.data?.reason); break;
        case 'audit_event':      prependActivity(msg.data); break;
        case 'inbox_changed':    updateInboxPill(msg.data.unprocessed); break;
        case 'identity_changed': handleIdentityChanged(msg.data); break;
        case 'cost_changed':     updateCostPill(msg.data); break;
        case 'presence_changed': handlePresence(msg.data?.presence || []); break;
        case 'toast':            toast(msg.data.text, msg.data.kind); break;
        default: break;
      }
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
  const presenceMap = state.presence || {};
  for (const a of state.agents) {
    const isHuman = a.code === 'PETER';
    const p = presenceMap[a.code];
    const isAlive = !!(p && p.is_alive);
    const isPaused = !!(p && p.paused);
    const pauseTitle = isPaused ? `Paused${p?.pause_reason ? ' — ' + p.pause_reason : ''}` : 'Pause agent';
    const li = document.createElement('li');
    li.className = 'agent-card' + (isPaused ? ' paused' : '') + (isHuman ? ' human' : '');
    if (isHuman) {
      // Peter is the human assignee — no kickoff (he's not a Claude session),
      // no pause/resume (you don't pause a human), no presence pulse (no
      // heartbeat possible). The card surfaces blockers/decisions visually
      // via the state light alone, derived from his ticket queue.
      li.innerHTML = `
        <span class="agent-emoji">${a.emoji}</span>
        <span class="agent-code">${a.code}</span>
        <span class="agent-meta">${a.current ? `${a.current.ticket_human_id} · ${a.current.status.replace('_',' ')}` : 'no blockers'}</span>
        <span class="human-tag" title="Peter is a human assignee — no kickoff, pre-compact, or pause needed">human</span>
        <span></span>
        <span></span>
        <span class="presence static" title="static — Peter doesn't heartbeat"></span>
        <span class="light" data-state="${a.light}" title="${a.light}"></span>
      `;
      li.addEventListener('click', () => openPeterTickets());
      ul.appendChild(li);
      continue;
    }
    li.innerHTML = `
      <span class="agent-emoji">${a.emoji}</span>
      <span class="agent-code">${a.code}${isPaused ? ' <span class="pause-badge" title="' + escapeHtml(pauseTitle) + '">⏸</span>' : ''}</span>
      <span class="agent-meta">${a.current ? `${a.current.ticket_human_id} · ${a.current.status.replace('_',' ')}` : 'idle'}</span>
      <button class="copy-kickoff" data-agent="${a.code}" title="Copy kickoff prompt for ${a.code}" type="button">📋</button>
      <button class="copy-precompact" data-agent="${a.code}" title="Pre-compact ${a.code}" type="button">📦</button>
      <button class="pause-btn" data-agent="${a.code}" title="${escapeHtml(isPaused ? 'Resume agent' : pauseTitle)}" type="button">${isPaused ? '▶' : '⏸'}</button>
      <span class="presence" data-state="${isAlive ? 'on' : 'off'}" title="${isAlive ? 'alive (heartbeat < 60s)' : 'silent'}"></span>
      <span class="light" data-state="${a.light}" title="${a.light}"></span>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.copy-kickoff') || e.target.closest('.copy-precompact') || e.target.closest('.pause-btn')) return;
      openSoul(a.code);
    });
    li.querySelector('.copy-kickoff').addEventListener('click', (e) => {
      e.stopPropagation();
      copyKickoffPrompt(a.code);
    });
    li.querySelector('.copy-precompact').addEventListener('click', (e) => {
      e.stopPropagation();
      copyPrecompactPrompt(a.code);
    });
    li.querySelector('.pause-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePause(a.code, isPaused);
    });
    ul.appendChild(li);
  }
}

async function copyPrecompactPrompt(code) {
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(code)}/precompact`).then((r) => r.json());
    if (!r.prompt) throw new Error('empty pre-compact');
    await navigator.clipboard.writeText(r.prompt);
    toast(`Pre-compact for ${code} copied — paste into the agent's terminal`, 'success');
  } catch (err) {
    toast('Pre-compact copy failed: ' + (err.message || err), 'error');
  }
}

// PETER doesn't have a soul.md or kickoff. Clicking his card filters the
// kanban down to his blocker queue so Peter (or whoever's looking) sees
// what's gating the marathon at a glance.
function openPeterTickets() {
  const sel = $('#filter-assignee');
  if (sel) {
    sel.value = 'PETER';
    state.filters.assignee = 'PETER';
    renderBoard();
  }
  toast('Filtered to PETER blockers', 'info');
}

async function togglePause(code, currentlyPaused) {
  const endpoint = currentlyPaused ? 'resume' : 'pause';
  let reason;
  if (!currentlyPaused) {
    reason = prompt(`Reason for pausing ${code}? (optional)`) || undefined;
  }
  try {
    const r = await fetch(`/api/board/agents/${encodeURIComponent(code)}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `${endpoint} ${r.status}`);
    }
    toast(`${code} ${endpoint}d`, 'success');
    // Presence poller will broadcast within 15s; force immediate refresh too.
    refreshPresence();
  } catch (err) {
    toast(`${endpoint} failed: ${err.message || err}`, 'error');
  }
}

async function refreshPresence() {
  try {
    const r = await fetch('/api/board/presence').then((r) => r.json());
    handlePresence(r.presence || []);
  } catch { /* ignore — endpoint may not be live yet (PH-072 not deployed) */ }
}

function handlePresence(rows) {
  const map = {};
  for (const r of rows) map[r.agent_code] = r;
  state.presence = map;
  renderAgents();
}

async function copyKickoffPrompt(code) {
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(code)}/kickoff`).then((r) => r.json());
    if (!r.prompt) throw new Error('empty kickoff');
    await navigator.clipboard.writeText(r.prompt);
    toast(`Kickoff for ${code} copied — paste into a fresh Claude Code session`, 'success');
  } catch (err) {
    toast('Kickoff copy failed: ' + (err.message || err), 'error');
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
  state.selectedTicketComments = [];
  const panel = $('#side-panel');
  panel.classList.remove('hidden');
  $('#side-body').textContent = 'Loading…';
  try {
    const r = await fetch(`/api/board/tickets/${id}`).then((r) => r.json());
    const t = r.ticket;
    state.selectedTicketComments = r.comments || [];
    $('#side-id').textContent = t.ticket_human_id;
    $('#side-status').textContent = t.status.replace('_', ' ');
    $('#side-status').className = 'status-pill ' + t.status;
    $('#side-body').innerHTML = renderTicketDetail(t, r.audit || [], state.selectedTicketComments);
  } catch (err) {
    $('#side-body').textContent = 'Failed to load: ' + (err.message || err);
  }
}

// Re-fetch the open ticket (silently — keep scroll/focus, no flash). Used by
// the legacy `tickets_changed` fallback path; granular events already patch
// state in place via handleCommentAdded etc.
async function refreshOpenTicket() {
  const id = state.selectedTicketId;
  if (!id) return;
  try {
    const r = await fetch(`/api/board/tickets/${id}`).then((r) => r.json());
    const t = r.ticket;
    state.selectedTicketComments = r.comments || [];
    $('#side-id').textContent = t.ticket_human_id;
    $('#side-status').textContent = t.status.replace('_', ' ');
    $('#side-status').className = 'status-pill ' + t.status;
    $('#side-body').innerHTML = renderTicketDetail(t, r.audit || [], state.selectedTicketComments);
  } catch { /* silent */ }
}

function closeSidePanel() {
  $('#side-panel').classList.add('hidden');
  state.selectedTicketId = null;
  state.selectedTicketComments = [];
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
  const ctaBar = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <button class="btn-secondary" id="soul-copy-kickoff" type="button">📋 Copy kickoff prompt</button>
      <span style="font-size:11px;color:var(--text-mid)">Paste into a fresh Claude Code session</span>
    </div>
  `;
  $('#side-body').innerHTML = ctaBar + 'Loading soul…';
  $('#soul-copy-kickoff').addEventListener('click', () => copyKickoffPrompt(code));
  try {
    const r = await fetch(`/api/agents/${code}/soul`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      $('#side-body').innerHTML = ctaBar + `<div style="color:var(--text-mid)">${escapeHtml(err.error || 'Soul file not available yet.')}</div>`;
      $('#soul-copy-kickoff').addEventListener('click', () => copyKickoffPrompt(code));
      return;
    }
    const md = await r.text();
    $('#side-body').innerHTML = ctaBar + `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
    $('#soul-copy-kickoff').addEventListener('click', () => copyKickoffPrompt(code));
  } catch (err) {
    $('#side-body').innerHTML = ctaBar + 'Failed: ' + escapeHtml(err.message || String(err));
    $('#soul-copy-kickoff').addEventListener('click', () => copyKickoffPrompt(code));
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
        assignee_agent: $('#note-assignee')?.value || 'CEO',
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

// ─── Identity switcher (PH-069 v0.3.0) ───

function populateIdentityDropdown(allowed, current) {
  const sel = $('#who-select');
  sel.innerHTML = '';
  for (const code of allowed) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${AGENT_EMOJI[code] || ''} ${code}`;
    if (code === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function switchIdentity(code) {
  if (!code || code === state.me) return;
  try {
    const r = await fetch('/api/me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentCode: code }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `identity ${r.status}`);
    }
    const data = await r.json();
    state.me = data.agentCode;
    toast(`Identity → ${data.agentCode}`, 'success');
    refreshBoard();
    refreshInbox();
  } catch (err) {
    toast('Switch failed: ' + (err.message || err), 'error');
    populateIdentityDropdown(['SA','AD','WA','DA','QA','WD','CEO','TA'], state.me);
  }
}

function handleIdentityChanged({ agentCode }) {
  state.me = agentCode;
  $('#who-select').value = agentCode;
  // The "My inbox" tab is filtered by current identity; refresh it.
  renderInbox();
}

// ─── Cost telemetry (PH-069 v0.3.0) ───

async function refreshCost() {
  try {
    const r = await fetch('/api/cost/summary').then((r) => r.json());
    state.cost = r;
    updateCostPill({ todayUsd: r.totals?.todayUsd ?? 0, thirtyDayUsd: r.totals?.thirtyDayUsd ?? 0 });
    if (!$('#cost-modal').classList.contains('hidden')) renderCostModal();
  } catch { /* offline ok */ }
}

function updateCostPill({ todayUsd, thirtyDayUsd }) {
  $('#cost-pill').hidden = false;
  $('#cost-today').textContent = `$${(todayUsd ?? 0).toFixed(2)}`;
  $('#cost-30d').textContent = `$${(thirtyDayUsd ?? 0).toFixed(2)}`;
}

async function openCostModal() {
  await refreshCost();
  renderCostModal();
  $('#cost-modal').classList.remove('hidden');
}

function closeCostModal() {
  $('#cost-modal').classList.add('hidden');
}

function renderCostModal() {
  const data = state.cost;
  if (!data) return;
  $('#cost-modal-foot').textContent = `${data.totals.fires} fires logged`;
  const totals = $('#cost-totals');
  totals.innerHTML = '';
  for (const [label, value] of [
    ['Today', `$${data.totals.todayUsd.toFixed(2)}`],
    ['30-day projection', `$${data.totals.thirtyDayUsd.toFixed(2)}`],
    ['Per-fire', `$${data.perFireUsd.toFixed(4)}`],
  ]) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>`;
    totals.appendChild(li);
  }
  const ul = $('#cost-rows');
  ul.innerHTML = '';
  if (!data.perAgent.length) {
    const li = document.createElement('li');
    li.innerHTML = `<div></div><div>No heartbeat logs yet.</div><div></div><div></div><div></div>`;
    ul.appendChild(li);
    return;
  }
  for (const r of data.perAgent) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="agent-emoji">${AGENT_EMOJI[r.agent] || ''}</span>
      <span><b>${escapeHtml(r.agent)}</b><br><span class="meta">${r.fires} fires · ${r.firesToday} today</span></span>
      <span class="meta">${r.lastFireAt ? formatTime(r.lastFireAt) : '—'}</span>
      <span class="usd">$${r.estimatedUsdToday.toFixed(2)}<span class="meta"> today</span></span>
      <span class="usd">$${r.estimatedUsd.toFixed(2)}<span class="meta"> total</span></span>
    `;
    ul.appendChild(li);
  }
}

// ─── Granular WS handlers (PH-052) ───

function markSeen(id) {
  if (!id) return true; // no id → treat as fresh, no dedupe
  if (state.seenEventIds.has(id)) return false;
  state.seenEventIds.add(id);
  if (state.seenEventIds.size > 512) {
    // Trim oldest insertions; Set preserves insertion order
    const overflow = state.seenEventIds.size - 512;
    let i = 0;
    for (const v of state.seenEventIds) { if (i++ >= overflow) break; state.seenEventIds.delete(v); }
  }
  return true;
}

let lastGranularAt = 0;
function maybeFullRefresh(reason) {
  // The legacy `tickets_changed` is a fallback. If a granular handler ran
  // in the last 2s, we already reflect the change — skip the full refetch
  // to avoid redundant network + reflow. Otherwise refresh the board.
  if (Date.now() - lastGranularAt < 2000) return;
  refreshBoard();
  refreshOpenTicket();
}

function noteGranularApplied() { lastGranularAt = Date.now(); }

function handleTicketCreated(ticket) {
  if (!ticket || !ticket.id) return;
  // Insert if not present, else patch in place
  const idx = state.tickets.findIndex((t) => t.id === ticket.id);
  if (idx >= 0) state.tickets[idx] = { ...state.tickets[idx], ...ticket };
  else state.tickets.unshift(ticket);
  state.agents = []; // re-derive lights via partial render? simplest: full re-render
  renderBoard();
  renderInbox();
  renderStats();
  renderBundle();
  // Agent rail derives from the server's `deriveAgentStates`. Since we're
  // patching client-side, do a quiet board refresh for the rail only.
  refreshAgentsQuietly();
  noteGranularApplied();
}

function handleTicketChanged({ ticket_id, after, fields_changed }) {
  if (!ticket_id) return;
  const idx = state.tickets.findIndex((t) => t.id === ticket_id);
  if (idx < 0) {
    // Not in our local set yet — fall back to a quiet refresh
    refreshBoard();
    return;
  }
  state.tickets[idx] = { ...state.tickets[idx], ...(after || {}) };
  renderBoard();
  renderInbox();
  renderStats();
  if (state.selectedTicketId === ticket_id) {
    // Patch the open panel header without losing scroll
    const t = state.tickets[idx];
    $('#side-status').textContent = t.status.replace('_', ' ');
    $('#side-status').className = 'status-pill ' + t.status;
  }
  refreshAgentsQuietly();
  noteGranularApplied();
}

function handleCommentAdded({ ticket_id, comment }) {
  if (!ticket_id || !comment) return;
  if (state.selectedTicketId === ticket_id) {
    const arr = state.selectedTicketComments || [];
    if (!arr.find((c) => c.id === comment.id)) {
      arr.push(comment);
      state.selectedTicketComments = arr.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      const t = state.tickets.find((x) => x.id === ticket_id) || { title: $('#side-id').textContent, audience: '', type: '', body_md: '', assignee_agent: null };
      $('#side-body').innerHTML = renderTicketDetail(t, [], state.selectedTicketComments);
    }
  }
  noteGranularApplied();
}

function handleCommentDeleted({ ticket_id, comment_id }) {
  if (!ticket_id || !comment_id) return;
  if (state.selectedTicketId === ticket_id) {
    state.selectedTicketComments = (state.selectedTicketComments || []).filter((c) => c.id !== comment_id);
    const t = state.tickets.find((x) => x.id === ticket_id);
    if (t) $('#side-body').innerHTML = renderTicketDetail(t, [], state.selectedTicketComments);
  }
  noteGranularApplied();
}

// Lightweight rail refresh — re-derives agent lights from /api/board/tickets
// without throwing the entire board through a re-render. Used after granular
// state mutations so traffic lights stay accurate.
let railTimer = null;
function refreshAgentsQuietly() {
  clearTimeout(railTimer);
  railTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/board/tickets').then((r) => r.json());
      state.agents = r.agents || [];
      renderAgents();
    } catch { /* ignore */ }
  }, 250);
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
