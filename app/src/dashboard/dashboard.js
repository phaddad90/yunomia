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
  filters: { audience: '', assignee: '', q: '', due: '' },
  activity: [],
  ws: null,
  refreshTimer: null,
  selectedTicketId: null,
  selectedTicketComments: [],
  seenEventIds: new Set(),    // dedupe granular WS events between local-write and audit-poll paths
  presence: {},                // agent_code → AgentPresence
  schedules: {},               // PH-118: ticket_id → { scheduled_for, set_by, set_at, ticket_human_id, ticket_title }
  eligibility: null,           // PH-127: latest eligible-actions response for selectedTicketId
  killSwitch: { disabled: false },  // PH-127: { disabled, disabled_at, disabled_by, reason, updated_at }
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
  await refreshPresence();
  await refreshKillSwitch();
  setInterval(refreshKillSwitch, 30_000);   // PH-127
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
      if (which === 'lessons') refreshLessons();
    });
  });

  // Lessons tab — search, filter, new
  $('#lessons-q').addEventListener('input', debounce(refreshLessons, 200));
  $('#lessons-severity').addEventListener('change', refreshLessons);
  $('#lessons-tag').addEventListener('input', debounce(refreshLessons, 200));
  $('#lessons-new').addEventListener('click', () => openLessonModal());
  $$('#lesson-modal [data-close="1"]').forEach((el) => el.addEventListener('click', closeLessonModal));
  $('#lesson-form').addEventListener('submit', (e) => { e.preventDefault(); submitLesson(); });

  $('#refresh').addEventListener('click', refreshBoard);
  $('#filter-audience').addEventListener('change', (e) => { state.filters.audience = e.target.value; renderBoard(); });
  $('#filter-assignee').addEventListener('change', (e) => { state.filters.assignee = e.target.value; renderBoard(); });
  $('#filter-q').addEventListener('input', debounce((e) => { state.filters.q = e.target.value.toLowerCase(); renderBoard(); }, 200));
  $('#filter-due').addEventListener('change', (e) => { state.filters.due = e.target.value; renderBoard(); });

  // Note form
  $('#note-form').addEventListener('submit', (e) => { e.preventDefault(); submitNote(); });
  $('#btn-screenshot').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', handleFileAttach);
  $('#btn-voice').addEventListener('click', toggleVoice);

  // Identity switcher
  $('#who-select').addEventListener('change', (e) => switchIdentity(e.target.value));

  // Inbox pill + modal
  $('#inbox-pill').addEventListener('click', openInboxModal);
  $('#inbox-mark-all').addEventListener('click', markAllInboxProcessed);
  $$('#inbox-modal [data-close="1"]').forEach((el) => el.addEventListener('click', closeInboxModal));

  // Side panel
  $('#side-close').addEventListener('click', closeSidePanel);
  $('#side-copy').addEventListener('click', copyPromptForSelected);
  $('#side-start').addEventListener('click', () => transitionSelected('start'));
  $('#side-handoff').addEventListener('click', () => transitionSelected('handoff'));
  $('#side-done').addEventListener('click', () => {
    // PH-108: confirm BEFORE posting — the lesson-capture dialog fires after the
    // transition completes, so Cancel there can't undo an accidental Done.
    const id = $('#side-id').textContent || 'this ticket';
    if (!confirm(`Mark ${id} as done?`)) return;
    transitionSelected('done');
  });
  // PH-108: manual status mover. Click any card → side panel opens → pick a
  // status here to move the ticket. Reverses accidental Done clicks too.
  $('#side-status-mover').addEventListener('change', (e) => moveSelectedToStatus(e.target.value));

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
        case 'presence_changed': handlePresence(msg.data?.presence || []); break;
        case 'toast':            toast(msg.data.text, msg.data.kind); break;
        case 'lint_completed':   handleLintCompleted(msg.data); break;            // PH-127: async lint patch
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
    const [r, sched] = await Promise.all([
      fetch('/api/board/tickets?' + params.toString()),
      fetch('/api/board/schedules').catch(() => null),
    ]);
    if (!r.ok) throw new Error(`board fetch ${r.status}`);
    const data = await r.json();
    state.tickets = data.tickets || [];
    state.agents = data.agents || [];
    if (sched && sched.ok) {
      const sd = await sched.json();
      state.schedules = {};
      for (const e of sd.schedules || []) state.schedules[e.ticket_id] = e;
    }
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

// PH-094: Done + Released default-collapsed with localStorage persistence.
const COLLAPSIBLE_COLS = new Set(['done', 'released']);
function isColCollapsed(colId) {
  if (!COLLAPSIBLE_COLS.has(colId)) return false;
  const stored = localStorage.getItem(`mc.collapsed.${colId}`);
  if (stored === null) return true;   // default: collapsed
  return stored === '1';
}
function setColCollapsed(colId, collapsed) {
  localStorage.setItem(`mc.collapsed.${colId}`, collapsed ? '1' : '0');
}
const SHOW_LIMIT_WHEN_EXPANDED = 10;

function renderBoard() {
  const root = $('#kanban');
  root.innerHTML = '';
  const filtered = state.tickets.filter(matchFilters);
  for (const col of COLUMNS) {
    const cards = filtered.filter((t) => t.status === col.id);
    const collapsible = COLLAPSIBLE_COLS.has(col.id);
    const collapsed = collapsible && isColCollapsed(col.id);
    const showAll = collapsible && state.colShowAll?.[col.id];
    const colEl = document.createElement('div');
    colEl.className = 'col' + (collapsed ? ' collapsed' : '');
    const arrow = collapsible ? `<button class="col-toggle" data-col="${col.id}" type="button">${collapsed ? '▶' : '▼'}</button>` : '';
    colEl.innerHTML = `<div class="col-head">${arrow}<span>${col.label}</span><span class="count">${cards.length}</span></div>`;
    if (!collapsed) {
      // Newest-first within done/released so the latest closes float to the top.
      // Otherwise: PH-118 — scheduled tickets bubble up; overdue first, then
      // due-soon, then unscheduled (preserve original order within each band).
      const ordered = collapsible
        ? cards.slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
        : cards.slice().sort(scheduleCompare);
      const limit = (collapsible && !showAll) ? SHOW_LIMIT_WHEN_EXPANDED : ordered.length;
      const visible = ordered.slice(0, limit);
      for (const t of visible) colEl.appendChild(renderTicketCard(t));
      if (collapsible && ordered.length > visible.length) {
        const more = document.createElement('button');
        more.className = 'show-all';
        more.type = 'button';
        more.dataset.col = col.id;
        more.textContent = `Show all ${ordered.length}`;
        colEl.appendChild(more);
      }
    }
    root.appendChild(colEl);
  }
  // Wire toggle + show-all buttons.
  $$('#kanban .col-toggle').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const colId = btn.dataset.col;
    setColCollapsed(colId, !isColCollapsed(colId));
    renderBoard();
  }));
  $$('#kanban .show-all').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.colShowAll = { ...(state.colShowAll || {}), [btn.dataset.col]: true };
    renderBoard();
  }));
}

function matchFilters(t) {
  const f = state.filters;
  if (f.audience && t.audience !== f.audience) return false;
  if (f.assignee && t.assignee_agent !== f.assignee) return false;
  if (f.q) {
    const hay = (t.title + ' ' + (t.body_md || '') + ' ' + t.ticket_human_id).toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  if (f.due) {
    const sched = state.schedules?.[t.id];
    if (!sched) return false;
    const when = new Date(sched.scheduled_for).getTime();
    const now = Date.now();
    if (f.due === 'overdue' && when > now) return false;
    if (f.due === 'today') {
      const end = endOfToday();
      if (when > end) return false;
    }
    if (f.due === 'week') {
      const end = endOfThisWeek();
      if (when > end) return false;
    }
    // 'scheduled' = any scheduled — already passed the !sched gate
  }
  return true;
}

// PH-118: order within a column — overdue ↑, then due-in-future asc, then unscheduled.
function scheduleCompare(a, b) {
  const sa = state.schedules?.[a.id];
  const sb = state.schedules?.[b.id];
  if (!sa && !sb) return 0;
  if (sa && !sb) return -1;
  if (!sa && sb) return 1;
  return (sa.scheduled_for || '').localeCompare(sb.scheduled_for || '');
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function endOfThisWeek() {
  const d = new Date();
  const day = d.getDay();   // 0=Sun..6=Sat
  const daysToSun = (7 - day) % 7;
  d.setDate(d.getDate() + daysToSun);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function renderTicketCard(t) {
  const div = document.createElement('div');
  div.className = 'ticket';
  div.dataset.id = t.id;
  const sched = state.schedules?.[t.id];
  const schedBadge = sched ? renderScheduleBadge(sched) : '';
  div.innerHTML = `
    <div class="ticket-head">
      <span class="ticket-id">${t.ticket_human_id}</span>
      <span class="ticket-assignee">${t.assignee_agent ? AGENT_EMOJI[t.assignee_agent] || '' : ''} ${t.assignee_agent || ''}</span>
    </div>
    <div class="ticket-title">${escapeHtml(t.title)}</div>
    <div class="ticket-foot">
      <span class="ticket-pill ${t.audience}">${t.audience}</span>
      <span class="ticket-pill ${t.type}">${t.type}</span>
      ${schedBadge}
    </div>
  `;
  div.addEventListener('click', () => openTicket(t.id));
  return div;
}

// PH-118: schedule badge — 🔔 + relative time. Red when overdue.
function renderScheduleBadge(s) {
  const when = new Date(s.scheduled_for);
  const overdue = when.getTime() <= Date.now();
  const cls = overdue ? 'sched-badge overdue' : 'sched-badge';
  return `<span class="${cls}" title="Scheduled for ${escapeHtml(s.scheduled_for)}">🔔 ${escapeHtml(formatScheduledRel(when))}</span>`;
}

function formatScheduledRel(when) {
  const ms = when.getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  if (ms <= 0) {
    if (m < 60) return `${m}m overdue`;
    if (h < 48) return `${h}h overdue`;
    return `${d}d overdue`;
  }
  if (m < 60) return `in ${m}m`;
  if (h < 48) return `in ${h}h`;
  return `in ${d}d`;
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
    showStatusMover(t.status);
    $('#side-body').innerHTML = renderTicketDetail(t, r.audit || [], state.selectedTicketComments);
    wireSchedulePicker(t);
    void refreshEligibility(t.id);
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
    showStatusMover(t.status);
    $('#side-body').innerHTML = renderTicketDetail(t, r.audit || [], state.selectedTicketComments);
    wireSchedulePicker(t);
    void refreshEligibility(t.id);
  } catch { /* silent */ }
}

function closeSidePanel() {
  $('#side-panel').classList.add('hidden');
  state.selectedTicketId = null;
  state.selectedTicketComments = [];
  hideStatusMover();
}

function renderTicketDetail(t, audit, commentsArr) {
  const refs = (() => { try { return JSON.parse(t.references_json || '[]'); } catch { return []; } })();
  const refList = refs.length ? `<h4>References</h4><ul>${refs.map((r) => `<li>${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</li>`).join('')}</ul>` : '';
  // PH-118: schedule picker. datetime-local input pre-filled with current value,
  // Save / Clear buttons. State of the input is hydrated from state.schedules.
  const sched = state.schedules?.[t.id];
  const schedValue = sched ? toDatetimeLocalValue(sched.scheduled_for) : '';
  const schedMeta = sched ? `<span class="sched-meta">set by ${escapeHtml(sched.set_by || '?')} · ${escapeHtml(sched.scheduled_for || '')}</span>` : '';
  const schedBlock = `
    <h4>Scheduled for</h4>
    <div class="sched-row">
      <input type="datetime-local" id="sched-input" value="${escapeHtml(schedValue)}" />
      <button class="btn-secondary" id="sched-save" type="button">Save</button>
      <button class="btn-ghost" id="sched-clear" type="button" ${sched ? '' : 'disabled'}>Clear</button>
    </div>
    <div class="sched-meta-line">${schedMeta}</div>
  `;
  // PH-051: comments come from {ticket, audit, comments} now. Oldest-first
  // matches the API order so verdicts read top-to-bottom in chronological
  // order (the comm layer relies on this — readers should see SA → AD → QA
  // top-down, not the reverse).
  const list = (commentsArr || []).slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const comments = list.map((c) => `
    <div class="comment">
      <div class="who">${escapeHtml(c.author_label || c.author_kind || '')} · ${formatTime(c.created_at)}</div>
      ${renderLintBannerFor(c)}
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
    ${schedBlock}
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

async function moveSelectedToStatus(newStatus) {
  if (!state.selectedTicketId || !newStatus) return;
  try {
    const r = await fetch(`/api/board/tickets/${state.selectedTicketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!r.ok) throw new Error(`patch ${r.status}`);
    toast(`Moved to ${newStatus.replace('_', ' ')}`, 'success');
    await openTicket(state.selectedTicketId);
    refreshBoard();
  } catch (err) {
    toast('Move failed: ' + (err.message || err), 'error');
  }
}

// PH-127: kill-switch banner refresh — every 30s + on boot.
async function refreshKillSwitch() {
  try {
    const r = await fetch('/api/board/compliance/kill-switch');
    if (!r.ok) return;
    state.killSwitch = await r.json();
    renderKillSwitchBanner();
  } catch { /* silent — endpoint may not be deployed yet */ }
}

function renderKillSwitchBanner() {
  const el = $('#kill-switch-banner');
  if (!el) return;
  const ks = state.killSwitch || {};
  if (!ks.disabled) { el.hidden = true; el.textContent = ''; return; }
  const by = ks.disabled_by || 'admin';
  const at = ks.disabled_at ? new Date(ks.disabled_at).toLocaleString() : 'unknown time';
  const reason = ks.reason ? ` — reason: ${ks.reason}` : '';
  el.textContent = `⚠ Compliance disabled by ${by} since ${at}${reason}. All rule blocks bypassed; every action is being audit-logged as bypass.`;
  el.hidden = false;
}

// PH-127: fetch eligibility for the open ticket and apply to action buttons.
async function refreshEligibility(ticketId) {
  try {
    const r = await fetch(`/api/board/tickets/${ticketId}/eligible-actions`);
    if (!r.ok) { applyEligibility(null); return; }
    state.eligibility = await r.json();
    applyEligibility(state.eligibility);
  } catch { applyEligibility(null); }
}

function applyEligibility(e) {
  // Default: all enabled, no tooltip. If we have an eligibility object, gate per flag.
  const setBtn = (sel, can, reason) => {
    const btn = $(sel);
    if (!btn) return;
    btn.disabled = e ? !can : false;
    btn.title = (e && !can && reason) ? reason : '';
  };
  setBtn('#side-start',   e ? e.can_start   : true, e?.start_reason);
  setBtn('#side-handoff', e ? e.can_handoff : true, e?.handoff_reason);
  setBtn('#side-done',    e ? e.can_done    : true, e?.done_reason);
}

// PH-127: WS event for async-lint completion. Patch the comment in place.
function handleLintCompleted(data) {
  if (!data || !data.comment_id) return;
  if (data.ticket_id !== state.selectedTicketId) return;
  const idx = (state.selectedTicketComments || []).findIndex((c) => c.id === data.comment_id);
  if (idx < 0) return;
  state.selectedTicketComments[idx] = {
    ...state.selectedTicketComments[idx],
    lint_warnings_json: data.warnings || [],
  };
  // Re-render the comments section without reloading the whole panel.
  const t = state.tickets.find((x) => x.id === state.selectedTicketId);
  if (t) {
    $('#side-body').innerHTML = renderTicketDetail(t, [], state.selectedTicketComments);
    wireSchedulePicker(t);
  }
}

// PH-127: parse + render lint warnings stored on a comment.
function renderLintBannerFor(comment) {
  let arr = comment.lint_warnings_json;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = []; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const items = arr.map((w) => {
    const rule = w.ruleId || w.rule_id || w.rule || 'lint';
    const msg = w.message || String(w);
    return `<li><b>${escapeHtml(rule)}</b> — ${escapeHtml(msg)}</li>`;
  }).join('');
  return `<div class="lint-banner"><div class="lint-head">⚠ Lint</div><ul>${items}</ul></div>`;
}

// PH-118: pre-fill `<input type="datetime-local">` from an ISO string in local TZ.
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function wireSchedulePicker(t) {
  const input = $('#sched-input');
  const save = $('#sched-save');
  const clear = $('#sched-clear');
  if (!input || !save || !clear) return;
  save.addEventListener('click', async () => {
    const v = input.value;
    if (!v) { toast('Pick a date and time first', 'error'); return; }
    const when = new Date(v);   // datetime-local is parsed as local time
    if (Number.isNaN(when.getTime())) { toast('Invalid date', 'error'); return; }
    try {
      const r = await fetch(`/api/board/tickets/${t.id}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduled_for: when.toISOString(),
          ticket_human_id: t.ticket_human_id,
          ticket_title: t.title,
        }),
      });
      if (!r.ok) throw new Error(`schedule ${r.status}`);
      const data = await r.json();
      if (data?.schedule) state.schedules[t.id] = data.schedule;
      toast(`Scheduled ${t.ticket_human_id} for ${when.toLocaleString()}`, 'success');
      await openTicket(t.id);
      renderBoard();
    } catch (err) {
      toast('Schedule save failed: ' + (err.message || err), 'error');
    }
  });
  clear.addEventListener('click', async () => {
    try {
      const r = await fetch(`/api/board/tickets/${t.id}/schedule`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`clear ${r.status}`);
      delete state.schedules[t.id];
      toast(`Cleared schedule on ${t.ticket_human_id}`, 'success');
      await openTicket(t.id);
      renderBoard();
    } catch (err) {
      toast('Clear failed: ' + (err.message || err), 'error');
    }
  });
}

function showStatusMover(currentStatus) {
  const sel = $('#side-status-mover');
  sel.innerHTML = '';
  for (const c of COLUMNS) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    if (c.id === currentStatus) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.hidden = false;
}

function hideStatusMover() {
  const sel = $('#side-status-mover');
  sel.innerHTML = '';
  sel.hidden = true;
}

// Open the agent side panel with Soul | Kickoff | Goals tabs.
// Soul is read-only; Kickoff + Goals each have a textarea + Save (file-backed
// per PH-090 / PH-092). Each tab lazy-hydrates on first activation.
async function openSoul(code) {
  const panel = $('#side-panel');
  panel.classList.remove('hidden');
  $('#side-id').textContent = code;
  $('#side-status').textContent = 'agent';
  $('#side-status').className = 'status-pill';
  hideStatusMover();
  state.selectedAgentCode = code;
  state.agentPanelHydrated = { soul: false, kickoff: false, goals: false };
  $('#side-body').innerHTML = `
    <nav class="agent-tabs">
      <button class="agent-tab active" data-agent-tab="soul" type="button">Soul</button>
      <button class="agent-tab" data-agent-tab="kickoff" type="button">Kickoff</button>
      <button class="agent-tab" data-agent-tab="goals" type="button">Goals</button>
    </nav>
    <section class="agent-tab-panel" id="agent-tab-soul">
      <div id="soul-preview"><span style="color:var(--text-mid)">Loading…</span></div>
    </section>
    <section class="agent-tab-panel hidden" id="agent-tab-kickoff">
      <div class="agent-tab-actions">
        <button class="btn-secondary" id="soul-copy-kickoff" type="button">📋 Copy to clipboard</button>
        <span class="agent-tab-hint">Paste into a fresh Claude Code session</span>
      </div>
      <textarea id="kickoff-editor" rows="14" placeholder="Loading…"></textarea>
      <div class="goals-controls">
        <span id="kickoff-status" class="goals-status"></span>
        <button id="kickoff-save" class="btn-primary" type="button" disabled>Save</button>
      </div>
    </section>
    <section class="agent-tab-panel hidden" id="agent-tab-goals">
      <textarea id="goals-editor" rows="14" placeholder="Loading…"></textarea>
      <div class="goals-controls">
        <span id="goals-status" class="goals-status"></span>
        <button id="goals-save" class="btn-primary" type="button" disabled>Save</button>
      </div>
    </section>
  `;
  // Tab switcher
  $$('.agent-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.agentTab;
      $$('.agent-tab').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.agent-tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `agent-tab-${which}`));
      void hydrateAgentTab(which, code);
    });
  });
  // Soul is the default tab — hydrate now.
  await hydrateAgentTab('soul', code);
}

async function hydrateAgentTab(which, code) {
  if (state.agentPanelHydrated && state.agentPanelHydrated[which]) return;
  state.agentPanelHydrated[which] = true;
  if (which === 'soul')    return hydrateSoul(code);
  if (which === 'kickoff') return hydrateKickoffEditor(code);
  if (which === 'goals')   return hydrateGoalsEditor(code);
}

async function hydrateSoul(code) {
  const target = $('#soul-preview');
  if (!target) return;
  try {
    const r = await fetch(`/api/agents/${code}/soul`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      target.innerHTML = `<div style="color:var(--text-mid)">${escapeHtml(err.error || 'Soul file not available.')}</div>`;
      return;
    }
    const md = await r.text();
    target.innerHTML = `<pre style="white-space:pre-wrap;background:var(--surface-2);padding:12px;border-radius:8px;font-size:12.5px">${escapeHtml(md)}</pre>`;
  } catch (err) {
    target.textContent = 'Failed: ' + (err.message || err);
  }
}

// Reusable file-backed editor wiring — same shape for kickoff and goals.
function wireFileBackedEditor({ code, kind, fetchKey, payloadKey, taId, saveBtnId, statusId, emptyBoilerplate, copyBtnId }) {
  const ta = $('#' + taId);
  const saveBtn = $('#' + saveBtnId);
  const status = $('#' + statusId);
  if (!ta || !saveBtn) return Promise.resolve();
  if (copyBtnId) {
    const copyBtn = $('#' + copyBtnId);
    if (copyBtn) copyBtn.addEventListener('click', () => copyKickoffPrompt(code));
  }
  let original = '';
  return fetch(`/api/agents/${encodeURIComponent(code)}/${kind}`).then((r) => r.json()).then((r) => {
    original = r[fetchKey] || '';
    if (!original.trim() && emptyBoilerplate) {
      ta.value = '';
      ta.placeholder = emptyBoilerplate;
    } else {
      ta.value = original;
    }
    status.textContent = `source: ${r.source || '?'}`;
    ta.addEventListener('input', () => {
      saveBtn.disabled = (ta.value === original) || ta.value.length === 0;
      status.textContent = saveBtn.disabled ? 'no changes' : 'edited — click Save';
    });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      status.textContent = 'saving…';
      try {
        const r2 = await fetch(`/api/agents/${encodeURIComponent(code)}/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [payloadKey]: ta.value }),
        });
        if (!r2.ok) {
          const err = await r2.json().catch(() => ({}));
          throw new Error(err.error || `save ${r2.status}`);
        }
        original = ta.value;
        status.textContent = 'saved · ' + (await r2.json()).path.split('/').pop();
        toast(`${kind[0].toUpperCase() + kind.slice(1)} for ${code} saved`, 'success');
      } catch (err) {
        status.textContent = 'save failed';
        toast(`${kind} save failed: ` + (err.message || err), 'error');
        saveBtn.disabled = false;
      }
    });
  }).catch((err) => {
    status.textContent = 'Failed to load ' + kind + ': ' + (err.message || err);
  });
}

async function hydrateKickoffEditor(code) {
  await wireFileBackedEditor({
    code,
    kind: 'kickoff',
    fetchKey: 'prompt',
    payloadKey: 'prompt',
    taId: 'kickoff-editor',
    saveBtnId: 'kickoff-save',
    statusId: 'kickoff-status',
    copyBtnId: 'soul-copy-kickoff',
    emptyBoilerplate: `No kickoff captured yet for ${code}. Edit + Save to populate.`,
  });
}

async function hydrateGoalsEditor(code) {
  await wireFileBackedEditor({
    code,
    kind: 'goals',
    fetchKey: 'goals',
    payloadKey: 'goals',
    taId: 'goals-editor',
    saveBtnId: 'goals-save',
    statusId: 'goals-status',
    emptyBoilerplate: `No goals captured yet for ${code}. Edit + Save to populate.`,
  });
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

// ─── Lessons tab (PH-095) ───

let lessonsLoading = false;
async function refreshLessons() {
  if (lessonsLoading) return;
  lessonsLoading = true;
  const ul = $('#lessons-list');
  const empty = $('#lessons-empty');
  try {
    const params = new URLSearchParams();
    const q = $('#lessons-q').value.trim();
    const sev = $('#lessons-severity').value;
    const tag = $('#lessons-tag').value.trim();
    if (q) params.set('q', q);
    if (sev) params.set('severity', sev);
    if (tag) params.set('tag', tag);
    const r = await fetch('/api/board/lessons?' + params.toString()).then((r) => r.json());
    const lessons = r.lessons || r.rows || [];
    state.lessons = lessons;
    ul.innerHTML = '';
    if (r.unavailable) {
      empty.classList.remove('hidden');
      empty.textContent = `Bug Lessons KB endpoint unavailable (${r.reason}). MC will populate this view automatically once SA's PH-088 deploys.`;
      return;
    }
    if (!lessons.length) {
      empty.classList.remove('hidden');
      empty.textContent = q || sev || tag
        ? 'No matching lessons.'
        : 'No lessons captured yet. Lessons accumulate as bugs are fixed.';
      return;
    }
    empty.classList.add('hidden');
    for (const l of lessons) ul.appendChild(renderLessonCard(l));
  } catch (err) {
    empty.classList.remove('hidden');
    empty.textContent = 'Lessons load failed: ' + (err.message || err);
  } finally {
    lessonsLoading = false;
  }
}

function renderLessonCard(l) {
  const tags = Array.isArray(l.tags) ? l.tags : (typeof l.tags === 'string' ? l.tags.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const sev = (l.severity || 'medium').toLowerCase();
  const linked = l.ticket_human_id || l.ticket_ph || '';
  const id = l.id || l.lesson_human_id || l.bl_id || '';
  const title = l.symptom || l.title || '(no symptom)';
  const li = document.createElement('li');
  li.className = 'lesson-card';
  li.innerHTML = `
    <div class="lesson-row1">
      <span class="lesson-id">${escapeHtml(String(id))}</span>
      <span class="lesson-sev sev-${sev}">${escapeHtml(sev)}</span>
      ${linked ? `<span class="lesson-linked">↪ ${escapeHtml(linked)}</span>` : ''}
    </div>
    <div class="lesson-symptom">${escapeHtml(title)}</div>
    ${tags.length ? `<div class="lesson-tags">${tags.map((t) => `<span class="lesson-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
  `;
  li.addEventListener('click', () => openLessonDetail(l));
  return li;
}

async function openLessonDetail(l) {
  const panel = $('#side-panel');
  panel.classList.remove('hidden');
  $('#side-id').textContent = l.id || l.lesson_human_id || 'BL';
  $('#side-status').textContent = l.severity || 'lesson';
  $('#side-status').className = 'status-pill';
  hideStatusMover();
  state.selectedTicketId = null; // not a ticket
  $('#side-body').textContent = 'Loading…';
  try {
    const id = l.id || l.lesson_human_id || l.bl_id;
    const full = id ? await fetch(`/api/board/lessons/${encodeURIComponent(String(id))}`).then((r) => r.json()) : { lesson: l };
    const body = full.lesson || full.row || full;
    $('#side-body').innerHTML = renderLessonDetail(body);
  } catch {
    $('#side-body').innerHTML = renderLessonDetail(l);
  }
}

function renderLessonDetail(l) {
  const tags = Array.isArray(l.tags) ? l.tags : (typeof l.tags === 'string' ? l.tags.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const sev = (l.severity || 'medium').toLowerCase();
  const fields = [
    ['Symptom', l.symptom],
    ['Root cause', l.root_cause],
    ['Fix', l.fix],
    ['Files changed', l.files_changed],
    ['How to recognise next time', l.recognise_pattern],
    ['Prevent action', l.prevent_action],
  ];
  return `
    <h2 style="margin:0 0 8px">${escapeHtml(l.symptom || l.title || 'Bug Lesson')}</h2>
    <div style="font-size:12px;color:var(--text-mid);margin-bottom:14px">
      <span class="lesson-sev sev-${sev}">${escapeHtml(sev)}</span>
      ${l.ticket_human_id ? ' · ↪ ' + escapeHtml(l.ticket_human_id) : ''}
      ${tags.length ? ' · ' + tags.map((t) => `<span class="lesson-tag">${escapeHtml(t)}</span>`).join(' ') : ''}
    </div>
    ${fields.map(([label, val]) => val ? `
      <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mid);margin:14px 0 6px">${escapeHtml(label)}</h4>
      <pre style="white-space:pre-wrap;background:var(--surface-2);padding:10px 12px;border-radius:8px;font-size:12.5px">${escapeHtml(String(val))}</pre>
    ` : '').join('')}
  `;
}

// ─── Lesson modal (new + bug-close hook) ───

function openLessonModal(prefill = {}) {
  $('#lesson-symptom').value = prefill.symptom || '';
  $('#lesson-sev').value = prefill.severity || 'medium';
  $('#lesson-tags').value = prefill.tags || '';
  $('#lesson-ticket').value = prefill.ticket_human_id || '';
  $('#lesson-root').value = prefill.root_cause || '';
  $('#lesson-fix').value = prefill.fix || '';
  $('#lesson-files').value = prefill.files_changed || '';
  $('#lesson-recognise').value = prefill.recognise_pattern || '';
  $('#lesson-prevent').value = prefill.prevent_action || '';
  $('#lesson-status').textContent = '';
  $('#lesson-modal-title').textContent = prefill._fromTicket ? `Capture lesson from ${prefill.ticket_human_id}` : 'New Bug Lesson';
  $('#lesson-modal').classList.remove('hidden');
}

function closeLessonModal() { $('#lesson-modal').classList.add('hidden'); }

async function submitLesson() {
  const status = $('#lesson-status');
  status.textContent = 'saving…';
  const body = {
    symptom: $('#lesson-symptom').value.trim(),
    severity: $('#lesson-sev').value,
    tags: $('#lesson-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
    ticket_human_id: $('#lesson-ticket').value.trim() || null,
    root_cause: $('#lesson-root').value,
    fix: $('#lesson-fix').value,
    files_changed: $('#lesson-files').value,
    recognise_pattern: $('#lesson-recognise').value,
    prevent_action: $('#lesson-prevent').value,
  };
  if (!body.symptom) { status.textContent = 'symptom required'; return; }
  try {
    const r = await fetch('/api/board/lessons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `lesson ${r.status}`);
    }
    closeLessonModal();
    toast('Lesson captured', 'success');
    // Refresh if we're on the Lessons tab
    if (!$('#panel-lessons').classList.contains('hidden')) refreshLessons();
  } catch (err) {
    status.textContent = 'failed: ' + (err.message || err);
    toast('Lesson save failed: ' + (err.message || err), 'error');
  }
}

// Bug-close hook: when a ticket transitions to `done` and type is bug, prompt
// "Capture lesson?" with prefilled template. Wired into the granular WS event
// stream so it fires for any ticket.changed → status: done with type: bug.
function maybePromptLessonCapture(ticket) {
  if (!ticket || ticket.type !== 'bug' || ticket.status !== 'done') return;
  if (!confirm(`PH-${ticket.ticket_human_id || '?'} closed. Capture a Bug Lesson?`)) return;
  openLessonModal({
    _fromTicket: true,
    ticket_human_id: ticket.ticket_human_id,
    symptom: ticket.title || '',
    severity: 'medium',
    root_cause: '',
    fix: '',
  });
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
  const before = state.tickets[idx];
  state.tickets[idx] = { ...before, ...(after || {}) };
  // PH-095: bug-close hook fires when type=bug + status flips to done
  if (after && after.status === 'done' && before.status !== 'done') {
    maybePromptLessonCapture(state.tickets[idx]);
  }
  renderBoard();
  renderInbox();
  renderStats();
  if (state.selectedTicketId === ticket_id) {
    // Patch the open panel header without losing scroll
    const t = state.tickets[idx];
    $('#side-status').textContent = t.status.replace('_', ' ');
    $('#side-status').className = 'status-pill ' + t.status;
    showStatusMover(t.status);
    void refreshEligibility(t.id);   // PH-127: status flipped → eligibility may have flipped too
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
