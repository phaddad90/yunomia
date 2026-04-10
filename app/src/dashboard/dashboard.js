// ─── Yunomia Dashboard ───
// Vanilla JS. No framework. No build step.

// ─── State ───
let ws = null;
let ceoTerminal = null;
let ceoFitAddon = null;
let workerTerminals = {};
let activeTerminal = 'ceo';
let paused = false;
let stopped = false;
let lastPromptTime = 0;
let statusFailCount = 0;
const PROMPT_COOLDOWN = 5000;

// ─── WebSocket ───

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.onopen = () => {
    ws = socket;
    setConnectionStatus('online');
    showBanner('Connected', 'info');
    setTimeout(() => hideBanner(), 2000);
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
    if (ws === socket) ws = null;
    if (stopped) return;
    setConnectionStatus('offline');
    showBanner('Disconnected - reconnecting...', 'warning');
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

  // Fit after layout settles (double-rAF ensures paint has happened)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ceoFitAddon.fit();
  }));

  ceoTerminal.writeln('\x1b[1;35m  Yunomia CEO Terminal\x1b[0m');
  ceoTerminal.writeln('\x1b[90m  Waiting for CEO agent to start...\x1b[0m\r\n');

  window.addEventListener('resize', () => {
    if (activeTerminal === 'ceo' && ceoFitAddon) {
      ceoFitAddon.fit();
    } else if (workerTerminals[activeTerminal]?.fitAddon) {
      workerTerminals[activeTerminal].fitAddon.fit();
    }
  });
}

let ceoOutputTimer = null;

function handleTerminalOutput(agentId, data) {
  // xterm.js needs \r\n - bare \n moves cursor down without returning to column 0
  const normalized = typeof data === 'string' ? data.replace(/\r?\n/g, '\r\n') : data;

  if (!agentId || agentId === 'ceo') {
    if (ceoTerminal) {
      ceoTerminal.write(normalized);
      ceoTerminal.scrollToBottom();
      // Timestamp after CEO stops sending for 2 seconds
      if (ceoOutputTimer) clearTimeout(ceoOutputTimer);
      ceoOutputTimer = setTimeout(() => {
        ceoTerminal.write(`\r\n\x1b[90m${timeStamp()}\x1b[0m\r\n`);
        ceoOutputTimer = null;
      }, 2000);
    }
  } else {
    if (!workerTerminals[agentId]) {
      createWorkerTerminal(agentId);
    }
    workerTerminals[agentId].terminal.write(normalized);
    workerTerminals[agentId].terminal.scrollToBottom();
  }
}

function createWorkerTerminal(agentId) {
  const container = document.createElement('div');
  container.id = `terminal-${agentId}`;
  container.className = 'terminal-wrapper';
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

  container.classList.add('hidden'); // hidden until user clicks

  workerTerminals[agentId] = { terminal, fitAddon, container, needsFit: true };
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

  document.getElementById('terminal-ceo').classList.add('hidden');
  Object.values(workerTerminals).forEach(w => w.container.classList.add('hidden'));

  workerTerminals[agentId].container.classList.remove('hidden');
  requestAnimationFrame(() => {
    workerTerminals[agentId].fitAddon.fit();
    workerTerminals[agentId].needsFit = false;
  });
  activeTerminal = agentId;

  document.querySelectorAll('.worker-pill').forEach(p => p.classList.remove('active'));
  const pill = document.getElementById(`pill-${agentId}`);
  if (pill) pill.classList.add('active');

  document.getElementById('back-to-ceo').style.display = 'block';
}

function showCeoTerminal() {
  Object.values(workerTerminals).forEach(w => w.container.classList.add('hidden'));
  document.getElementById('terminal-ceo').classList.remove('hidden');
  requestAnimationFrame(() => { if (ceoFitAddon) ceoFitAddon.fit(); });
  activeTerminal = 'ceo';

  document.querySelectorAll('.worker-pill').forEach(p => p.classList.remove('active'));
  document.getElementById('back-to-ceo').style.display = 'none';
}

// ─── Tasks ───

function renderTasks(state) {
  const container = document.getElementById('tasks-container');
  if (!state || !state.tasks) return;

  const sections = { planned: [], scheduled: [], active: [], done: [], failed: [], pulled: [] };
  state.tasks.forEach(t => sections[t.status]?.push(t));

  const labels = { planned: 'Planned', scheduled: 'Scheduled', active: 'Active', done: 'Done', failed: 'Failed', pulled: 'Pulled' };
  const checkmarks = { planned: '[ ]', scheduled: '[@]', active: '[~]', done: '[x]', failed: '[!]', pulled: '[-]' };
  const checkClass = { planned: '', scheduled: 'scheduled', active: 'active', done: 'done', failed: 'failed', pulled: 'pulled' };

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
                <span class="task-tag">$${(t.maxBudgetUsd ?? 0).toFixed(2)}</span>
                ${t.tokenCost?.totalUsd > 0 ? `<span class="task-tag" style="color: var(--green);">$${t.tokenCost.totalUsd.toFixed(2)} actual</span>` : ''}
                ${status === 'active' && t.assignee && activeAgentCosts[t.assignee] ? `<span class="task-tag" style="color: var(--amber);">$${activeAgentCosts[t.assignee].toFixed(2)} running</span>` : ''}
                ${t.scheduledFor ? `<span class="task-tag" style="color: var(--blue);">@ ${new Date(t.scheduledFor).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>` : ''}
                ${t.notes ? `<span style="color: var(--text-muted);">${escapeHtml(t.notes)}</span>` : ''}
              </div>
            </div>
            <div class="task-actions">
              ${status === 'failed' ? `<button class="btn" data-action="retry" data-id="${escapeHtml(t.id)}">Retry</button>` : ''}
              ${status === 'planned' ? `<button class="btn btn-danger" data-action="pull" data-id="${escapeHtml(t.id)}">Pull</button>` : ''}
              ${status === 'active' ? `<button class="btn btn-danger" data-action="stop" data-id="${escapeHtml(t.id)}">Stop</button>` : ''}
            </div>
          </div>`;
      }
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  // Attach event listeners (not inline onclick - prevents XSS)
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (action === 'retry') retryTask(id);
      else if (action === 'pull') pullTask(id);
      else if (action === 'stop') failTask(id);
    });
  });
}

async function addTask() {
  const input = document.getElementById('add-task-input');
  const scheduleInput = document.getElementById('add-task-schedule');
  const title = input.value.trim();
  if (!title) return;

  const body = { title };
  if (scheduleInput.value) {
    body.scheduledFor = new Date(scheduleInput.value).toISOString();
  }

  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  input.value = '';
  scheduleInput.value = '';
}

async function retryTask(id) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'planned', notes: '', retryCount: 0 }),
  });
}

async function pullTask(id) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'pulled', notes: 'Pulled by human' }),
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
      ${statusRow('Version', 'v' + (health.version || '?'))}
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

    // Populate settings with current values (only on first load)
    loadSettingsValues(safety.config, health.ceo.model);

    updateStatusBar(health, heartbeat);
    updateCostBadge(health.budget);

    // Version + project display
    const versionEl = document.getElementById('app-version');
    if (versionEl && health.version) versionEl.textContent = 'v' + health.version;
    if (health.project) {
      currentProjectPath = health.project;
      const projEl = document.getElementById('project-name');
      if (projEl) projEl.textContent = health.project.split('/').pop() || health.project;
    }

    // Fetch and render metrics
    try {
      const metricsSummary = await fetch('/api/metrics/summary').then(r => r.json());
      renderMetrics(metricsSummary);
    } catch { /* metrics endpoint may not be ready */ }
  } catch (e) {
    statusFailCount++;
    if (statusFailCount >= 3) {
      showBanner('Status polling failed - data may be stale', 'warning');
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

let pendingImages = []; // { data: base64, mediaType: string, previewUrl: string }
let speechRecognition = null;
let isRecording = false;

function initPromptInput() {
  const input = document.getElementById('prompt-input');
  const wrapper = document.getElementById('prompt-wrapper');

  // Enter sends, Shift+Enter inserts newline
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // Auto-resize
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  // ─── Image Drag & Drop ───
  wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    wrapper.classList.add('drag-over');
  });

  wrapper.addEventListener('dragleave', () => {
    wrapper.classList.remove('drag-over');
  });

  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    wrapper.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  // Paste images (Cmd+V)
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        handleFiles([item.getAsFile()]);
        break;
      }
    }
  });

  // Keyboard shortcut: V for voice (when not focused on textarea)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'v' && document.activeElement !== input && !e.metaKey && !e.ctrlKey) {
      toggleVoice();
    }
  });
}

function handleFiles(files) {
  if (!files) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (pendingImages.length >= 5) break;
    if (file.size > 5 * 1024 * 1024) continue; // 5MB max per image

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(',')[1];
      const previewUrl = e.target.result;
      pendingImages.push({ data: base64, mediaType: file.type, previewUrl });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  }
}

function renderImagePreviews() {
  const container = document.getElementById('image-previews');
  container.innerHTML = '';
  pendingImages.forEach((img, i) => {
    const div = document.createElement('div');
    div.className = 'image-preview';
    div.innerHTML = `<img src="${img.previewUrl}" alt="attachment"><button class="remove-img" data-idx="${i}">x</button>`;
    div.querySelector('.remove-img').addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });
    container.appendChild(div);
  });
}

async function sendPrompt() {
  const input = document.getElementById('prompt-input');
  const message = input.value.trim();
  if (!message && pendingImages.length === 0) return;

  if (Date.now() - lastPromptTime < PROMPT_COOLDOWN) return;
  lastPromptTime = Date.now();

  const text = message || '(see attached images)';

  // Echo in terminal - extra blank line for separation from CEO response
  if (ceoTerminal) {
    const ts = timeStamp();
    const lines = text.split('\n').map(l => l.replace(/\r/g, ''));
    ceoTerminal.write(`\r\n\x1b[1;36m> You:\x1b[0m ${lines[0]}\r\n`);
    for (let i = 1; i < lines.length; i++) {
      ceoTerminal.write(`\x1b[1;36m  |\x1b[0m ${lines[i]}\r\n`);
    }
    if (pendingImages.length > 0) {
      ceoTerminal.write(`\x1b[1;36m  |\x1b[0m \x1b[90m[${pendingImages.length} image${pendingImages.length > 1 ? 's' : ''} attached]\x1b[0m\r\n`);
    }
    ceoTerminal.write(`\x1b[90m${ts}\x1b[0m\r\n`);
  }

  const body = { message: text };
  if (pendingImages.length > 0) {
    body.images = pendingImages.map(img => ({ data: img.data, mediaType: img.mediaType }));
  }

  input.value = '';
  input.style.height = 'auto';
  pendingImages = [];
  renderImagePreviews();

  await fetch('/api/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Voice Input ───

function toggleVoice() {
  if (isRecording) {
    stopVoice();
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showBanner('Voice input not supported in this browser', 'warning');
    setTimeout(hideBanner, 3000);
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-GB';

  const input = document.getElementById('prompt-input');
  const btn = document.getElementById('mic-btn');
  let finalTranscript = input.value;

  speechRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + ' ';
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    input.value = finalTranscript + interim;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  };

  speechRecognition.onerror = (e) => {
    if (e.error !== 'aborted') {
      console.error('Speech error:', e.error);
    }
    stopVoice();
  };

  speechRecognition.onend = () => {
    if (isRecording) {
      // Restart if still in recording mode (browser auto-stops after silence)
      try { speechRecognition.start(); } catch { stopVoice(); }
    }
  };

  speechRecognition.start();
  isRecording = true;
  btn.classList.add('recording');
  btn.textContent = 'Stop';
}

function stopVoice() {
  if (speechRecognition) {
    isRecording = false;
    try { speechRecognition.stop(); } catch { /* ignore */ }
    speechRecognition = null;
  }
  const btn = document.getElementById('mic-btn');
  btn.classList.remove('recording');
  btn.textContent = 'Mic';
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
  showSleepScreen();
  // Fire shutdown AFTER sleep screen is showing - server may die before response
  fetch('/api/shutdown', { method: 'POST' }).catch(() => {});
}

async function approveSpawn(taskId) {
  await fetch(`/api/safety/approve/${taskId}`, { method: 'POST' });
  hideBanner();
}

async function rejectSpawn(taskId) {
  await fetch(`/api/safety/reject/${taskId}`, { method: 'POST' });
  hideBanner();
}

// ─── Settings ───

let settingsLoaded = false;

function loadSettingsValues(config, ceoModel) {
  if (settingsLoaded || !config) return;
  settingsLoaded = true;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = String(val); };
  set('setting-ceo-model', ceoModel || 'claude-sonnet-4-6');
  set('setting-max-workers', config.maxConcurrentWorkers);
  set('setting-budget', config.maxDailyBudgetUsd);
  set('setting-heartbeat', config.heartbeatIntervalMinutes);
  set('setting-worker-timeout', config.maxWorkerRuntimeMinutes);
  set('setting-inactivity', config.inactivityPauseMinutes);
  set('setting-approval', String(config.requireApprovalForSpawn));
}

async function saveSettings() {
  const get = (id) => document.getElementById(id)?.value;

  const safetyUpdate = {
    maxConcurrentWorkers: parseInt(get('setting-max-workers')),
    maxDailyBudgetUsd: parseInt(get('setting-budget')),
    heartbeatIntervalMinutes: parseInt(get('setting-heartbeat')),
    maxWorkerRuntimeMinutes: parseInt(get('setting-worker-timeout')),
    inactivityPauseMinutes: parseInt(get('setting-inactivity')),
    requireApprovalForSpawn: get('setting-approval') === 'true',
  };

  await fetch('/api/safety/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(safetyUpdate),
  });

  // CEO model change requires a note - can't hot-swap mid-session
  const statusEl = document.getElementById('settings-status');
  statusEl.textContent = 'Saved';
  statusEl.style.color = 'var(--green)';

  const selectedModel = get('setting-ceo-model');
  const currentModel = document.querySelector('[id="ceo-status-rows"]')?.textContent;
  if (selectedModel && !currentModel?.includes(selectedModel)) {
    statusEl.textContent = 'Saved (CEO model applies on next restart)';
    statusEl.style.color = 'var(--amber)';
  }

  settingsLoaded = false; // refresh on next poll
  setTimeout(() => { statusEl.textContent = ''; }, 4000);
}

// ─── Skills ───

let skillsCache = null;

async function loadSkills() {
  try {
    const skills = await fetch('/api/skills').then(r => r.json());
    skillsCache = skills;
    renderSkills(skills);
  } catch { /* ignore */ }
}

function renderSkills(skills) {
  const container = document.getElementById('skills-list');
  if (!skills || skills.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; padding: 8px 0; font-size: 13px; color: var(--text-muted);">No skills found</div>';
    return;
  }

  container.innerHTML = skills.map(s => `
    <div class="skill-card" data-skill="${escapeHtml(s.name)}">
      <div style="font-weight: 500; font-size: 13px;">${escapeHtml(s.name)}</div>
      <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">${escapeHtml(s.description)}</div>
      <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
        ${escapeHtml(s.mode)} ${s.workers ? '(' + s.workers.length + ' workers)' : ''} ${s.workerModel ? '[' + s.workerModel + ']' : ''}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.skill-card').forEach(card => {
    card.addEventListener('click', () => {
      const name = card.getAttribute('data-skill');
      const skill = skills.find(s => s.name === name);
      if (skill) showSkillConfig(skill);
    });
  });
}

function showSkillConfig(skill) {
  const card = document.getElementById('skill-config-card');
  const form = document.getElementById('skill-config-form');
  card.style.display = 'block';

  const fields = skill.configFields || [];
  let html = `<div style="font-size: 13px; margin-bottom: 10px;"><strong>${escapeHtml(skill.name)}</strong> - ${escapeHtml(skill.description)}</div>`;

  if (fields.length > 0) {
    html += '<div class="settings-grid">';
    for (const field of fields) {
      html += `<label>${escapeHtml(field.label)}<input type="text" id="skill-cfg-${escapeHtml(field.name)}" placeholder="${field.required ? 'Required' : 'Optional'}" style="padding:6px 8px;font-size:13px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);outline:none;font-family:var(--font-mono);color-scheme:dark;"></label>`;
    }
    html += '</div>';
  } else {
    html += '<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">No configuration needed.</div>';
  }

  html += '<div style="margin-top: 10px;"><button class="btn btn-accent" id="run-skill-btn">Run Skill</button> <span id="skill-run-status" style="font-size: 12px;"></span></div>';
  form.innerHTML = html;

  document.getElementById('run-skill-btn').addEventListener('click', async () => {
    const cfg = {};
    for (const field of fields) {
      const val = document.getElementById('skill-cfg-' + field.name)?.value;
      if (val) cfg[field.name] = val;
    }

    const statusEl = document.getElementById('skill-run-status');
    statusEl.textContent = 'Running...';
    statusEl.style.color = 'var(--amber)';

    try {
      const result = await fetch('/api/skills/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName: skill.name, config: cfg }),
      }).then(r => r.json());

      if (result.status === 'failed') {
        statusEl.textContent = 'Failed: ' + (result.error || 'Unknown');
        statusEl.style.color = 'var(--red)';
      } else {
        statusEl.textContent = result.mode === 'multi-worker'
          ? `Started - ${result.workerCount} tasks created`
          : 'Started - check Tasks tab';
        statusEl.style.color = 'var(--green)';
      }
    } catch (err) {
      statusEl.textContent = 'Error';
      statusEl.style.color = 'var(--red)';
    }
  });
}

// ─── Sleep Screen ───

function showSleepScreen() {
  stopped = true;
  hideBanner();

  // Stop polling
  if (statusIntervalId) { clearInterval(statusIntervalId); statusIntervalId = null; }

  // Disable header buttons
  document.getElementById('pause-btn').disabled = true;
  document.getElementById('stop-btn').disabled = true;

  // Dispose all worker terminals
  for (const [id, w] of Object.entries(workerTerminals)) {
    w.terminal.dispose();
    w.container.remove();
    document.getElementById(`pill-${id}`)?.remove();
  }
  workerTerminals = {};

  // Hide all tabs and show sleep overlay
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tabs').style.display = 'none';
  document.querySelector('.prompt-bar').style.display = 'none';

  // Create sleep overlay
  const overlay = document.createElement('div');
  overlay.id = 'sleep-screen';
  overlay.style.cssText = `
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 16px; color: var(--text-muted);
    font-size: 14px; background: var(--bg-primary);
  `;
  const restartCmd = `npm run dev -- --project ${currentProjectPath || '/path/to/project'}`;
  overlay.innerHTML = `
    <div style="font-size: 32px; font-weight: 600; color: var(--text-secondary); font-family: var(--font-mono);">Yunomia</div>
    <div style="color: var(--text-muted);">Session ended. All agents stopped.</div>
    <div style="margin-top: 12px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);">Restart with:</div>
    <div style="margin-top: 4px; display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 13px; color: var(--accent); padding: 8px 16px; background: var(--bg-tertiary); border-radius: 6px; border: 1px solid var(--border);">
      <span style="user-select: all;">${escapeHtml(restartCmd)}</span>
      <span id="copy-btn" style="cursor: pointer; opacity: 0.6; font-size: 16px;" title="Copy to clipboard">&#x2398;</span>
    </div>
  `;

  document.getElementById('copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(restartCmd);
      document.getElementById('copy-btn').textContent = '\u2713';
      document.getElementById('copy-btn').style.opacity = '1';
      document.getElementById('copy-btn').style.color = '#22c55e';
      setTimeout(() => {
        const btn = document.getElementById('copy-btn');
        if (btn) { btn.textContent = '\u2398'; btn.style.opacity = '0.6'; btn.style.color = ''; }
      }, 2000);
    } catch { /* clipboard API may fail */ }
  });

  // Insert after tabs
  const statusBar = document.querySelector('.status-bar');
  statusBar.parentNode.insertBefore(overlay, statusBar);

  // Update status bar
  const dot = document.getElementById('ceo-dot');
  const state = document.getElementById('ceo-state');
  dot.className = 'dot stopped';
  state.textContent = 'Stopped';
  document.getElementById('status-bar').className = 'status-bar';
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

  if (tab === 'status') { refreshStatus(); loadSoulGoals(); }
  if (tab === 'skills' && !skillsCache) loadSkills();
}

// ─── Banner ───

function showBanner(text, type) {
  const banner = document.getElementById('banner');
  banner.textContent = text; // textContent, not innerHTML - safe
  banner.className = 'banner visible';
  if (type === 'warning') banner.classList.add('warning');
  if (type === 'danger') banner.classList.add('danger');
}

function hideBanner() {
  document.getElementById('banner').className = 'banner';
}

// ─── Helpers ───

function setConnectionStatus(status) {
  const bar = document.getElementById('status-bar');
  const existing = document.getElementById('connection-indicator');
  if (existing) existing.remove();

  if (status === 'offline') {
    const indicator = document.createElement('span');
    indicator.id = 'connection-indicator';
    indicator.style.cssText = 'color: var(--red); font-weight: 600;';
    indicator.textContent = 'OFFLINE';
    bar.prepend(indicator);
  }
}

function timeStamp() {
  const now = new Date();
  return now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ───

let statusIntervalId = null;
let currentProjectPath = '';
let activeAgentCosts = {}; // agentId -> costUsd

// ─── Onboarding ───

async function checkOnboarding() {
  try {
    const data = await fetch('/api/onboarding').then(r => r.json());
    if (data.needsOnboarding) {
      showOnboarding(data);
      return true;
    }
  } catch { /* server not ready yet */ }
  return false;
}

function showOnboarding(data) {
  document.getElementById('onboarding-screen').style.display = 'flex';

  // Set project name from path
  document.getElementById('ob-name').value = data.projectName || '';

  // Populate preset dropdown
  const presetSelect = document.getElementById('ob-preset');
  presetSelect.innerHTML = '';
  for (const p of (data.presets || [])) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} - ${p.description || ''}`;
    presetSelect.appendChild(opt);
  }

  // Set model
  if (data.currentModel) {
    document.getElementById('ob-model').value = data.currentModel;
  }
}

async function submitOnboarding() {
  const body = {
    projectName: document.getElementById('ob-name').value,
    mission: document.getElementById('ob-mission').value,
    goals: document.getElementById('ob-goals').value,
    preset: document.getElementById('ob-preset').value,
    model: document.getElementById('ob-model').value,
  };

  await fetch('/api/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  document.getElementById('onboarding-screen').style.display = 'none';
  // Reload to start fresh with the new config
  location.reload();
}

// ─── SOUL / GOALS Editors ───

let soulLoaded = false;
let goalsLoaded = false;

async function loadSoulGoals() {
  if (!soulLoaded) {
    try {
      const soul = await fetch('/api/ceo/soul').then(r => r.text());
      document.getElementById('soul-editor').value = soul;
      soulLoaded = true;
    } catch { /* ignore */ }
  }
  if (!goalsLoaded) {
    try {
      const goals = await fetch('/api/ceo/goals').then(r => r.text());
      document.getElementById('goals-editor').value = goals;
      goalsLoaded = true;
    } catch { /* ignore */ }
  }
}

async function saveSoul() {
  const content = document.getElementById('soul-editor').value;
  const statusEl = document.getElementById('soul-save-status');
  await fetch('/api/ceo/soul', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  statusEl.textContent = 'Saved';
  statusEl.style.color = 'var(--green)';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

async function saveGoals() {
  const content = document.getElementById('goals-editor').value;
  const statusEl = document.getElementById('goals-save-status');
  await fetch('/api/ceo/goals', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  statusEl.textContent = 'Saved';
  statusEl.style.color = 'var(--green)';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

// ─── Init ───

document.addEventListener('DOMContentLoaded', async () => {
  // Check onboarding first
  const needsOnboarding = await checkOnboarding();
  if (needsOnboarding) return; // Don't init anything else until onboarding completes

  initTerminals();
  initPromptInput();
  connectWs();

  // Browser online/offline detection
  window.addEventListener('offline', () => {
    setConnectionStatus('offline');
    showBanner('Network offline', 'danger');
  });
  window.addEventListener('online', () => {
    setConnectionStatus('online');
    showBanner('Network restored', 'info');
    setTimeout(() => hideBanner(), 2000);
    if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();
  });

  statusIntervalId = setInterval(() => {
    refreshStatus();
    // Refresh tasks + agent costs as a fallback
    Promise.all([
      fetch('/api/tasks').then(r => r.json()).catch(() => null),
      fetch('/api/agents').then(r => r.json()).catch(() => []),
    ]).then(([tasksData, agents]) => {
      // Build cost map from active workers
      activeAgentCosts = {};
      if (Array.isArray(agents)) {
        for (const a of agents) {
          if (a.role === 'worker' && a.info?.costUsd) {
            activeAgentCosts[a.id] = a.info.costUsd;
          }
        }
      }
      if (tasksData) renderTasks(tasksData);
    });
  }, 5000);
  refreshStatus();
});
