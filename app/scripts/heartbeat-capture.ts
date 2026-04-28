#!/usr/bin/env node --import tsx
/**
 * heartbeat-capture.ts — read the seven per-agent JSONL logs the
 * `heartbeat-check` skill leaves in ~/.printpepper/, fold them together with
 * any session-end token totals Peter pastes into a stub TSV, and emit the
 * empirical row of the cost report.
 *
 * Workflow (PH-045 step 3):
 *   1. Run /loop heartbeat-check in 7 terminals (one per PP_AGENT_CODE).
 *   2. After each Claude Code session ends, copy the final usage summary
 *      (tokens-in / tokens-out / cost) into ~/.printpepper/heartbeat-usage.tsv:
 *        AGENT<TAB>tokens_in<TAB>tokens_out<TAB>cost_usd
 *      One row per agent, header line optional.
 *   3. `npm run heartbeat-capture` aggregates everything and prints the
 *      report-ready table to stdout.
 *
 * Pure read-only — produces no API calls and never touches the board.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface HeartbeatLine {
  ts: string;
  agent: string;
  heartbeat: number;
  queue_count: number;
  state: 'active' | 'idle' | 'over';
  event?: string;
}

interface AgentUsage {
  agent: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

const root = join(homedir(), '.printpepper');
const usageFile = join(root, 'heartbeat-usage.tsv');

function readLogs(): Map<string, HeartbeatLine[]> {
  const out = new Map<string, HeartbeatLine[]>();
  if (!existsSync(root)) return out;
  for (const f of readdirSync(root)) {
    const m = f.match(/^heartbeat-log-([A-Z]+)\.jsonl$/);
    if (!m) continue;
    const agent = m[1];
    const lines: HeartbeatLine[] = [];
    for (const line of readFileSync(join(root, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip */ }
    }
    out.set(agent, lines);
  }
  return out;
}

function readUsage(): Map<string, AgentUsage> {
  const out = new Map<string, AgentUsage>();
  if (!existsSync(usageFile)) return out;
  for (const line of readFileSync(usageFile, 'utf-8').split('\n')) {
    const cells = line.split('\t').map((c) => c.trim());
    if (cells.length < 2 || cells[0].toLowerCase() === 'agent') continue;
    const agent = cells[0].toUpperCase();
    if (!agent) continue;
    out.set(agent, {
      agent,
      tokens_in: cells[1] ? Number(cells[1]) : undefined,
      tokens_out: cells[2] ? Number(cells[2]) : undefined,
      cost_usd: cells[3] ? Number(cells[3]) : undefined,
    });
  }
  return out;
}

function summarise(lines: HeartbeatLine[]): {
  count: number; capped: boolean; activeFires: number; idleFires: number; overFires: number;
} {
  let activeFires = 0, idleFires = 0, overFires = 0;
  let capped = false;
  let count = 0;
  for (const l of lines) {
    if (l.event === 'cap-reached') { capped = true; continue; }
    count++;
    if (l.state === 'active') activeFires++;
    else if (l.state === 'idle') idleFires++;
    else if (l.state === 'over') overFires++;
  }
  return { count, capped, activeFires, idleFires, overFires };
}

const logs = readLogs();
const usage = readUsage();

if (logs.size === 0) {
  process.stderr.write(`No heartbeat-log-*.jsonl files in ${root}.\nRun /loop heartbeat-check in 7 terminals first.\n`);
  process.exit(2);
}

const agents = Array.from(new Set([...logs.keys(), ...usage.keys()])).sort();

const rows = agents.map((a) => {
  const summary = summarise(logs.get(a) || []);
  const u = usage.get(a) || { agent: a };
  return { agent: a, ...summary, tokens_in: u.tokens_in, tokens_out: u.tokens_out, cost_usd: u.cost_usd };
});

const totals = rows.reduce(
  (acc, r) => ({
    count: acc.count + r.count,
    activeFires: acc.activeFires + r.activeFires,
    idleFires: acc.idleFires + r.idleFires,
    overFires: acc.overFires + r.overFires,
    tokens_in: acc.tokens_in + (r.tokens_in ?? 0),
    tokens_out: acc.tokens_out + (r.tokens_out ?? 0),
    cost_usd: acc.cost_usd + (r.cost_usd ?? 0),
  }),
  { count: 0, activeFires: 0, idleFires: 0, overFires: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
);

const fmt = (n: number | undefined) => n === undefined ? '—' : n.toLocaleString('en-GB');
const fmtUsd = (n: number | undefined) => n === undefined ? '—' : `$${n.toFixed(4)}`;

const out: string[] = [];
out.push(`PrintPepper heartbeat empirical capture · ${new Date().toISOString()}`);
out.push(`logs: ${root}/heartbeat-log-*.jsonl   usage: ${existsSync(usageFile) ? usageFile : '(missing — paste session totals to enable token rows)'}`);
out.push('');
out.push('agent | fires | active | idle | over | capped | tokens_in | tokens_out | cost');
out.push('----- | ----- | ------ | ---- | ---- | ------ | --------- | ---------- | ----');
for (const r of rows) {
  out.push(
    `${r.agent.padEnd(5)} | ${String(r.count).padStart(5)} | ${String(r.activeFires).padStart(6)} | ${String(r.idleFires).padStart(4)} | ${String(r.overFires).padStart(4)} | ${(r.capped ? 'yes' : 'no').padStart(6)} | ${fmt(r.tokens_in).padStart(9)} | ${fmt(r.tokens_out).padStart(10)} | ${fmtUsd(r.cost_usd).padStart(8)}`,
  );
}
out.push('----- | ----- | ------ | ---- | ---- | ------ | --------- | ---------- | ----');
out.push(`TOTAL | ${String(totals.count).padStart(5)} | ${String(totals.activeFires).padStart(6)} | ${String(totals.idleFires).padStart(4)} | ${String(totals.overFires).padStart(4)} |       | ${fmt(totals.tokens_in).padStart(9)} | ${fmt(totals.tokens_out).padStart(10)} | ${fmtUsd(totals.cost_usd).padStart(8)}`);

if (totals.count > 0 && totals.tokens_in === 0 && totals.tokens_out === 0) {
  out.push('');
  out.push(`(token columns blank — paste session-end summaries into ${usageFile} as TSV: AGENT<TAB>tokens_in<TAB>tokens_out<TAB>cost_usd, then re-run.)`);
}

process.stdout.write(out.join('\n') + '\n');
