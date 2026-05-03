// Yunomia — two-layer heartbeat.
//
// Layer 0 — mechanical safety-net (zero LLM tokens). Every 30s, walks each
// running pty: if we wrote a wakeup AT_T and the pty produced no stdout in
// the 5 minutes following, re-fire the wakeup prompt. Catches fired-but-
// missed wakeups, crashed-restart races, and pty layer hiccups.
//
// Layer 1 — CEO judgement-required hourly check. Writes a brief heartbeat
// prompt to the CEO pty if running, asking it to scan for stuck agents and
// reassign / nudge as needed. ~200-500 tokens/tick on Sonnet/Opus.

import { writeToAgent } from './mc-bridge.js';

const LAYER0_INTERVAL_MS = 30_000;
const LAYER0_STALL_MS    = 5 * 60_000;
const LAYER1_INTERVAL_MS = 60 * 60_000;

// agentCode → { lastWakeupAt: epoch_ms, lastStdoutAt: epoch_ms, ticketHumanId, reason }
const wakeups = new Map();
let l0Timer = null;
let l1Timer = null;

export function noteWakeupSent(agentCode, ticketHumanId, reason) {
  const prev = wakeups.get(agentCode) || {};
  wakeups.set(agentCode, {
    ...prev,
    lastWakeupAt: Date.now(),
    ticketHumanId,
    reason,
  });
}

export function noteStdoutFromAgent(agentCode) {
  const prev = wakeups.get(agentCode) || {};
  wakeups.set(agentCode, { ...prev, lastStdoutAt: Date.now() });
}

export function startHeartbeat({ getRunningAgents, rewakeAgent }) {
  l0Timer = setInterval(() => layer0Tick({ getRunningAgents, rewakeAgent }), LAYER0_INTERVAL_MS);
  l1Timer = setInterval(() => layer1Tick({ getRunningAgents }), LAYER1_INTERVAL_MS);
}

export function stopHeartbeat() {
  if (l0Timer) clearInterval(l0Timer);
  if (l1Timer) clearInterval(l1Timer);
  l0Timer = null; l1Timer = null;
}

function layer0Tick({ getRunningAgents, rewakeAgent }) {
  const running = new Set(getRunningAgents());
  const now = Date.now();
  for (const [code, w] of wakeups.entries()) {
    if (!running.has(code)) continue;
    if (!w.lastWakeupAt) continue;
    if (w.lastStdoutAt && w.lastStdoutAt >= w.lastWakeupAt) continue;  // already responded
    if (now - w.lastWakeupAt < LAYER0_STALL_MS) continue;               // still in grace
    console.warn(`[heartbeat-L0] ${code} stalled — re-firing wakeup`);
    rewakeAgent(code, w.ticketHumanId, w.reason || 're-wakeup');
    // Reset the wakeup timestamp so we don't re-fire every 30s.
    wakeups.set(code, { ...w, lastWakeupAt: now });
  }
}

async function layer1Tick({ getRunningAgents }) {
  const running = getRunningAgents();
  if (!running.includes('CEO')) {
    console.info('[heartbeat-L1] CEO not running — skipping');
    return;
  }
  const prompt = `\n\n[Yunomia heartbeat L1 — ${new Date().toISOString()}] Sweep the fleet: any agent assigned but not making progress? Any scheduled-for tickets due now? Any stuck verdicts in_review? If yes, nudge or reassign. If clear, reply OK and go back to sleep.\n`;
  try {
    await writeToAgent('CEO', prompt);
    console.info('[heartbeat-L1] sent to CEO');
  } catch (err) {
    console.warn('[heartbeat-L1] write failed', err);
  }
}
