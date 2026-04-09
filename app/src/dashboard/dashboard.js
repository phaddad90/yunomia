// ─── Eunomia Dashboard ───
// Vanilla JS. No framework. No build step.

// ─── State ───
let ws = null;
let ceoTerminal = null;
let ceoFitAddon = null;
let workerTerminals = {};
let activeTerminal = 'ceo';
let paused = false;
let lastPromptTime = 0;
let statusFailCount = 0;
const PROMPT_COOLDOWN = 5000;

// ─── WebSocket ───

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.onopen = () => {
    ws = socket; // only assign to global once open
    showBanner('Connected to Eunomia', 'info');
    setTimeout(() => hideBanner(), 3000);
    // Re-sync state on reconnect
    refreshStatus();
    fetch('/api/tasks').then(r => r.json()).then(data => renderTasks(data)).catch(() => {});
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error('Bad WS message:', e);
    }
  };

  socket.onclose = () => {
    if (ws === socket) ws = null; // don't clobber a newer connection
    showBanner('Disconnected — reconnecting...', 'warning');
    setTimeout(connectWs, 3000);
  };

  socket.onerror = () => {
    socket.close(); // close THIS socket, not whatever ws points to
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'terminal_output':
      handleTerminalOutput(msg.agentId, msg.data);
      break;
    case 'tasks_updated':
      renderTasks(msg.data);
      break;
    case 'agent_status':
      handleAgentStatus(msg.agentId, msg.data);
      break;
    case 'safety_alert':
      handleSafetyAlert(msg.data);
      break;
    case 'cost_update':
      handleCostUpdate(msg.data);
      break;
    case 'spawn_approval_request':
      handleSpawnApproval(msg.data);
      break;
  }
}

// ─── Terminal ───

function initTerminals() {
  ceoTerminal = new Terminal({
    theme: {
      background: '#0a0a0f',
      foreground: '#e4e4ef',
      cursor: '#6366f1',
      cursorAccent: '#0a0a0f',
      selectionBackground: 'rgba(99, 102, 241, 0.3)',
    },
    fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 1000,
    cursorBlink: true,
  });

  ceoFitAddon = new FitAddon.FitAddon();
  ceoTerminal.loadAddon(ceoFitAddon);
  ceoTerminal.open(document.getElementById('terminal-ceo'));

  // Fit after layout settles
  requestAnimationFrame(() => {
    ceoFitAddon.fit();
  });

  ceoTerminal.writeln('\x1b[1;35m  Eunomia CEO Terminal\x1b[0m');
  ceoTerminal.writeln('\x1b[90m  Waiting for CEO agent to start...\x1b[0m\r\n');

  window.addEventListener('resize', () => {
    if (activeTerminal === 'ceo' && ceoFitAddon) {
      ceoFitAddon.fit();
    } else if (workerTerminals[activeTerminal]?.fitAddon) {
      workerTerminals[activeTerminal].fitAddon.fit();
    }
  });
}

function handleTerminalOutput(agentId, data) {
  // xterm.js needs \r\n — bare \n moves cursor down without returning to column 0
  const normalized = typeof data === 'string' ? data.replace(/\r?\n/g, '\r\n') : data;

  if (!agentId || agentId === 'ceo') {
    if (ceoTerminal) ceoTerminal.write(normalized);
  } else {
    if (!workerTerminals[agentId]) {
      createWorkerTerminal(agentId);
    }
    workerTerminals[agentId].terminal.write(normalized);
  }
}

function createWorkerTerminal(agentId) {
  const container = document.createElement('div');
  container.id = `terminal-${agentId}`;
  container.style.height = '100%';
  container.style.width = '100%';
  container.style.position = 'absolute';
  container.style.inset = '0';
  // Temporarily visible for fit measurement
  document.querySelector('.terminal-main').appendChild(container);

  const terminal = new Terminal({
    theme: {
      background: '#0a0a0f',
      foreground: '#e4e4ef',
      cursor: '#22c55e',
    },
    fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 1000,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit(); // fit while visible

  container.style.display = 'none'; // hide after fit

  workerTerminals[agentId] = { terminal, fitAddon, container };
  addWorkerPill(agentId);
}

function addWorkerPill(agentId) {
  const bar = document.getElementById('worker-bar');
  const existing = document.getElementById(`pill-${agentId}`);
  if (existing) return;

  const pill = document.createElement('div');
  pill.className = 'worker-pill';
  pill.id = `pill-${agentId}`;
  pill.onclick = () => showWorkerTerminal(agentId);
  pill.innerHTML = `<span class="dot"></span>${escapeHtml(agentId.slice(0, 16))}`;
  bar.appendChild(pill);
}

function showWorkerTerminal(agentId) {
  if (!workerTerminals[agentId]) return;

  document.getElementById('terminal-ceo').style.display = 'none';
  Object.values(workerTerminals).forEach(w => w.container.style.display = 'none');

  workerTerminals[agentId].container.style.display = 'block';
  workerTerminals[agentId].fitAddon.fit();
  activeTerminal = agentId;

  document.querySelectorAll('.worker-pill').forEach(p => p.classList.remove('active'));
  const pill = document.getElementById(`pill-${agentId}`);
  if (pill) pill.classList.add('active');

  document.getElementById('back-to-ceo').style.display = 'block';
}

function showCeoTerminal() {
  Object.values(workerTerminals).forEach(w => w.container.style.display = 'none');
  document.getElementById('terminal-ceo').style.display = 'block';
  if (ceoFitAddon) ceoFitAddon.fit();
  activeTerminal = 'ceo';

  document.querySelectorAll('.worker-pill').forEach(p => p.classList.remove('active'));
  document.getElementById('back-to-ceo').style.display = 'none';
}

// ─── Tasks ───

function renderTasks(state) {
  const container = document.getElementById('tasks-container');
  if (!state || !state.tasks) return;

  const sections = { planned: [], active: [], done: [], failed: [] };
  state.tasks.forEach(t => sections[t.status]?.push(t));

  const labels = { planned: 'Planned', active: 'Active', done: 'Done', failed: 'Failed' };
  const checkmarks = { planned: '[ ]', active: '[~]', done: '[x]', failed: '[!]' };
  const checkClass = { planned: '', active: 'active', done: 'done', failed: 'failed' };

  let html = '';
  for (const [status, tasks] of Object.entries(sections)) {
    html += `<div class="tasks-section">`;
    html += `<div class="tasks-section-title">${labels[status]} (${tasks.length})</div>`;

    if (tasks.length === 0) {
      html += `<div style="padding: 8px 12px; font-size: 12px; color: var(--text-muted);">No tasks</div>`;
    } else {
      for (const t of tasks) {
        const priorityClass = t.priority === 'critical' ? 'priority-critical' : t.priority === 'high' ? 'priority-high' : '';
        html += `
          <div class="task-item" data-id="${escapeHtml(t.id)}">
            <span class="task-checkbox ${checkClass[status]}">${checkmarks[status]}</span>
            <div class="task-body">
              <div class="task-title">${escapeHtml(t.title)}</div>
              <div class="task-meta">
                <span class="task-tag">${escapeHtml(t.id)}</span>
                <span class="task-tag model">${escapeHtml(t.model)}</span>
                <span class="task-tag ${priorityClass}">${escapeHtml(t.priority)}</span>
                <span class="task-tag">$${t.maxBudgetUsd.toFixed(2)}</span>
                ${t.tokenCost?.totalUsd > 0 ? `<span class="task-tag" style="color: var(--green);">$${t.tokenCost.totalUsd.toFixed(2)} actual</span>` : ''}
                ${t.notes ? `<span style="color: var(--text-muted);">${escapeHtml(t.notes)}</span>` : ''}
              </div>
            </div>
            <div class="task-actions">
              ${status === 'failed' ? `<button class="btn" data-action="retry" data-id="${escapeHtml(t.id)}">Retry</button>` : ''}
              ${status === 'planned' ? `<button class="btn btn-danger" data-action="remove" data-id="${escapeHtml(t.id)}">Remove</button>` : ''}
              ${status === 'active' ? `<button class="btn btn-danger" data-action="stop" data-id="${escapeHtml(t.id)}">Stop</button>` : ''}
            </div>
          </div>`;
      }
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  // Attach event listeners (not inline onclick — prevents XSS)
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (action === 'retry') retryTask(id);
      else if (action === 'remove') deleteTask(id);
      else if (action === 'stop') failTask(id);
    });
  });
}

async function addTask() {
  const input = document.getElementById('add-task-input');
  const title = input.value.trim();
  if (!title) return;

  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });

  input.value = '';
}

async function retryTask(id) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'planned', notes: '', retryCount: 0 }),
  });
}

async function deleteTask(id) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', notes: 'Removed by human' }),
  });
}

async function failTask(id) {
  const agents = await (await fetch('/api/agents')).json();
  const worker = agents.find(a => a.taskId === id && a.role === 'worker');
  if (worker) {
    await fetch(`/api/agents/${worker.id}/kill`, { method: 'POST' });
  } else {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed', notes: 'Stopped by human' }),
    });
  }
}

// ─── Status Tab ───

async function refreshStatus() {
  try {
    const [health, heartbeat, agents, safety] = await Promise.all([
      fetch('/health').then(r => r.json()),
      fetch('/api/heartbeat').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()),
      fetch('/api/safety').then(r => r.json()),
    ]);

    statusFailCount = 0; // reset on success

    document.getElementById('ceo-status-rows').innerHTML = `
      ${statusRow('Status', health.ceo.status, health.ceo.status === 'running' ? 'green' : 'amber')}
      ${statusRow('Model', health.ceo.model)}
      ${statusRow('Session Age', health.ceo.sessionAge)}
      ${statusRow('Tokens Today', health.ceo.tokensToday.toLocaleString())}
      ${statusRow('Cost Today', '$' + health.ceo.costToday.toFixed(2))}
      ${statusRow('Heartbeat', heartbeat.state + ' (' + heartbeat.intervalMinutes + 'min)')}
      ${statusRow('Next In', heartbeat.nextFireIn + 's')}
    `;

    const workers = agents.filter(a => a.role === 'worker');
    if (workers.length === 0) {
      document.getElementById('worker-status-rows').innerHTML =
        '<div style="padding: 4px 0; font-size: 13px; color: var(--text-muted);">No active workers</div>';
    } else {
      document.getElementById('worker-status-rows').innerHTML = workers.map(w => `
        ${statusRow(w.id.slice(0, 12), w.status, w.status === 'running' ? 'green' : 'amber')}
        ${w.taskId ? statusRow('  Task', w.taskId) : ''}
        ${w.info ? statusRow('  Cost', '$' + (w.info.costUsd || 0).toFixed(2)) : ''}
      `).join('');
    }

    document.getElementById('cost-status-rows').innerHTML = `
      ${statusRow('Today', '$' + health.budget.spent.toFixed(2), health.budget.percent >= 80 ? 'amber' : '')}
      ${statusRow('Budget', '$' + health.budget.limit.toFixed(2))}
      ${statusRow('Used', health.budget.percent.toFixed(1) + '%', health.budget.percent >= 100 ? 'red' : health.budget.percent >= 80 ? 'amber' : 'green')}
    `;

    document.getElementById('safety-status-rows').innerHTML = `
      ${statusRow('Paused', safety.paused ? 'Yes' : 'No', safety.paused ? 'amber' : 'green')}
      ${statusRow('Workers', health.workers.active + '/' + health.workers.max)}
      ${statusRow('Inactive', safety.inactiveMinutes + ' min')}
      ${statusRow('Budget', safety.budgetPercent.toFixed(0) + '%', safety.budgetPercent >= 80 ? 'amber' : 'green')}
      ${statusRow('Approvals Pending', safety.pendingApprovals.length.toString())}
    `;

    updateStatusBar(health, heartbeat);
    updateCostBadge(health.budget);

    // Fetch and render metrics
    try {
      const metricsSummary = await fetch('/api/metrics/summary').then(r => r.json());
      renderMetrics(metricsSummary);
    } catch { /* metrics endpoint may not be ready */ }
  } catch (e) {
    statusFailCount++;
    if (statusFailCount >= 3) {
      showBanner('Status polling failed — data may be stale', 'warning');
    }
  }
}

function statusRow(label, value, colorClass) {
  return `<div class="status-row">
    <span class="status-label">${escapeHtml(String(label))}</span>
    <span class="status-value ${colorClass || ''}">${escapeHtml(String(value))}</span>
  </div>`;
}

// ─── Metrics Card ───

function renderMetrics(summary) {
  const el = document.getElementById('metrics-status-rows');
  if (!el || !summary) return;

  const successColor = summary.workerSuccessRate >= 80 ? 'green' : summary.workerSuccessRate >= 50 ? 'amber' : 'red';
  const skipColor = summary.heartbeatSkipRate <= 20 ? 'green' : summary.heartbeatSkipRate <= 50 ? 'amber' : 'red';

  el.innerHTML = `
    ${statusRow('Total Cost', '$' + (summary.totalCostUsd || 0).toFixed(2))}
    ${statusRow('Session Duration', (summary.sessionDurationMinutes || 0) + 'm')}
    ${statusRow('Tasks Completed', String(summary.tasksCompleted || 0), 'green')}
    ${statusRow('Tasks Failed', String(summary.tasksFailed || 0), summary.tasksFailed > 0 ? 'red' : '')}
    ${statusRow('Workers Spawned', String(summary.workersSpawned || 0))}
    ${statusRow('Success Rate', (summary.workerSuccessRate || 0) + '%', successColor)}
    ${statusRow('Heartbeats', String(summary.heartbeatCount || 0))}
    ${statusRow('HB Skip Rate', (summary.heartbeatSkipRate || 0) + '%', skipColor)}
    ${statusRow('Human Actions', String(summary.humanInteractions || 0))}
    ${statusRow('CEO Restarts', String(summary.ceoRestarts || 0))}
  `;
}

// ─── Status Bar ───

function updateStatusBar(health, heartbeat) {
  const dot = document.getElementById('ceo-dot');
  const state = document.getElementById('ceo-state');
  const workers = document.getElementById('worker-count');
  const cost = document.getElementById('status-cost');
  const hb = document.getElementById('heartbeat-info');
  const bar = document.getElementById('status-bar');

  const ceoStatus = health.ceo.status;
  if (ceoStatus === 'running') {
    dot.className = 'dot green';
    state.textContent = heartbeat.state === 'paused' ? 'Paused' : heartbeat.nextFireIn > 0 ? `Waiting (${Math.ceil(heartbeat.nextFireIn / 60)}m)` : 'Thinking';
  } else {
    dot.className = 'dot amber';
    state.textContent = ceoStatus;
  }

  workers.textContent = `${health.workers.active} worker${health.workers.active !== 1 ? 's' : ''}`;
  cost.textContent = `$${health.budget.spent.toFixed(2)} today`;
  hb.textContent = `HB: ${heartbeat.intervalMinutes}m`;

  bar.className = 'status-bar';
  if (health.budget.percent >= 100) bar.classList.add('danger');
  else if (health.budget.percent >= 80 || health.status === 'degraded') bar.classList.add('warning');
}

function updateCostBadge(budget) {
  const badge = document.getElementById('cost-badge');
  badge.textContent = `$${budget.spent.toFixed(2)}`;
  badge.className = 'cost-badge';
  if (budget.percent >= 100) badge.classList.add('danger');
  else if (budget.percent >= 80) badge.classList.add('warning');
}

// ─── Agent Status Events ───

function handleAgentStatus(agentId, data) {
  if (data.role === 'ceo') return;

  const pill = document.getElementById(`pill-${agentId}`);
  if (pill) {
    const dot = pill.querySelector('.dot');
    if (data.status === 'running') dot.className = 'dot';
    else if (data.status === 'stopped') dot.className = 'dot stopped';
    else if (data.status === 'crashed') dot.className = 'dot failed';
  }
}

function handleSafetyAlert(data) {
  if (data.action === 'paused') {
    paused = true;
    document.getElementById('pause-btn').textContent = 'Resume';
    showBanner(`System paused${data.reason ? ': ' + data.reason : ''}`, 'warning');
  } else if (data.action === 'resumed') {
    paused = false;
    document.getElementById('pause-btn').textContent = 'Pause';
    hideBanner();
  }
}

function handleCostUpdate(data) {
  const badge = document.getElementById('cost-badge');
  badge.textContent = `$${data.dailySpend.toFixed(2)}`;
  badge.className = 'cost-badge';
  if (data.exhausted) badge.classList.add('danger');
  else if (data.warning) badge.classList.add('warning');
}

function handleSpawnApproval(data) {
  const banner = document.getElementById('banner');
  banner.textContent = '';

  const text = document.createTextNode(`CEO wants to spawn worker for ${data.taskId} (${data.title}). `);
  banner.appendChild(text);

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-accent';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => approveSpawn(data.taskId));
  banner.appendChild(approveBtn);

  banner.appendChild(document.createTextNode(' '));

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn btn-danger';
  rejectBtn.textContent = 'Reject';
  rejectBtn.addEventListener('click', () => rejectSpawn(data.taskId));
  banner.appendChild(rejectBtn);

  banner.className = 'banner visible';
}

// ─── Controls ───

function initPromptInput() {
  const input = document.getElementById('prompt-input');

  // Enter sends, Shift+Enter inserts newline
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // Auto-resize textarea as content grows
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
}

async function sendPrompt() {
  const input = document.getElementById('prompt-input');
  const message = input.value.trim();
  if (!message) return;

  if (Date.now() - lastPromptTime < PROMPT_COOLDOWN) return;
  lastPromptTime = Date.now();

  // Echo the prompt in the CEO terminal so it feels like a conversation
  if (ceoTerminal) {
    const lines = message.split('\n').map(l => l.replace(/\r/g, ''));
    ceoTerminal.write(`\r\n\x1b[1;36m> You:\x1b[0m ${lines[0]}\r\n`);
    for (let i = 1; i < lines.length; i++) {
      ceoTerminal.write(`\x1b[1;36m  |\x1b[0m ${lines[i]}\r\n`);
    }
    ceoTerminal.write('\r\n');
  }

  input.value = '';
  input.style.height = 'auto';

  await fetch('/api/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

async function togglePause() {
  if (paused) {
    await fetch('/api/safety/resume', { method: 'POST' });
  } else {
    await fetch('/api/safety/pause', { method: 'POST' });
  }
}

async function stopAll() {
  if (!confirm('Stop all agents and shut down?')) return;
  showBanner('Shutting down...', 'danger');
  await fetch('/api/shutdown', { method: 'POST' }).catch(() => {});
}

async function approveSpawn(taskId) {
  await fetch(`/api/safety/approve/${taskId}`, { method: 'POST' });
  hideBanner();
}

async function rejectSpawn(taskId) {
  await fetch(`/api/safety/reject/${taskId}`, { method: 'POST' });
  hideBanner();
}

// ─── Tabs ───

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');

  if (tab === 'terminals') {
    requestAnimationFrame(() => {
      if (activeTerminal === 'ceo' && ceoFitAddon) ceoFitAddon.fit();
      else if (workerTerminals[activeTerminal]?.fitAddon) workerTerminals[activeTerminal].fitAddon.fit();
    });
  }

  if (tab === 'status') refreshStatus();
}

// ─── Banner ───

function showBanner(text, type) {
  const banner = document.getElementById('banner');
  banner.textContent = text; // textContent, not innerHTML — safe
  banner.className = 'banner visible';
  if (type === 'warning') banner.classList.add('warning');
  if (type === 'danger') banner.classList.add('danger');
}

function hideBanner() {
  document.getElementById('banner').className = 'banner';
}

// ─── Helpers ───

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ───

document.addEventListener('DOMContentLoaded', () => {
  initTerminals();
  initPromptInput();
  connectWs();

  setInterval(refreshStatus, 5000);
  refreshStatus();
});
