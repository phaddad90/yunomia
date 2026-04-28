import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentCode } from './types.js';

/**
 * Cost telemetry surface (PH-069 v0.3.0). Honest about being an estimate:
 * pulls per-agent fire counts from ~/.printpepper/heartbeat-log-<AGENT>.jsonl
 * (the same logs PH-046 / PH-061 §6 specified) and multiplies by the closed-
 * form per-fire token cost the simulator uses by default. Empirical refinement
 * lands when PH-045 capture data exists; until then this is the cheapest
 * accurate-order-of-magnitude signal we can render.
 */

// Defaults mirror app/scripts/heartbeat-simulate.ts so the simulator and the
// live header agree on the same model. Sonnet 4.6 list pricing.
export const COST_DEFAULTS = {
  cachedInPerFire: 3500,
  freshInPerFire: 500,
  outPerFire: 150,
  priceCachedRead: 0.30 / 1_000_000, // $/token
  priceFresh: 3.00 / 1_000_000,
  priceOut: 15.00 / 1_000_000,
};

function perFireUsd(): number {
  return (
    COST_DEFAULTS.cachedInPerFire * COST_DEFAULTS.priceCachedRead +
    COST_DEFAULTS.freshInPerFire * COST_DEFAULTS.priceFresh +
    COST_DEFAULTS.outPerFire * COST_DEFAULTS.priceOut
  );
}

interface AgentLine { ts: string; agent: string; heartbeat?: number; queue_count?: number; state?: string; event?: string }

export interface CostBreakdown {
  agent: AgentCode | string;
  fires: number;
  firesToday: number;
  estimatedUsd: number;
  estimatedUsdToday: number;
  lastFireAt: string | null;
}

export interface CostSummary {
  generatedAt: string;
  perFireUsd: number;
  totals: {
    fires: number;
    firesToday: number;
    todayUsd: number;
    thirtyDayUsd: number;     // projection assuming today's rate sustains
    monthAtFullRateUsd: number; // simulator mixed-mode 30d figure for context
  };
  perAgent: CostBreakdown[];
  source: { dir: string; files: string[] };
  estimate: true;             // make it explicit that this isn't measured
}

const LOG_DIR = join(homedir(), '.printpepper');

export function summariseCost(): CostSummary {
  const perFire = perFireUsd();
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const perAgent: CostBreakdown[] = [];
  let totalFires = 0;
  let totalFiresToday = 0;
  const files: string[] = [];

  if (existsSync(LOG_DIR)) {
    for (const f of readdirSync(LOG_DIR)) {
      const m = f.match(/^heartbeat-log-([A-Z]+)\.jsonl$/);
      if (!m) continue;
      const agent = m[1];
      const path = join(LOG_DIR, f);
      files.push(f);
      let fires = 0, firesToday = 0;
      let lastTs: string | null = null;
      try {
        const raw = readFileSync(path, 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let parsed: AgentLine;
          try { parsed = JSON.parse(line); } catch { continue; }
          if (parsed.event === 'cap-reached') continue;
          fires++;
          if (typeof parsed.ts === 'string') {
            if (parsed.ts.startsWith(todayPrefix)) firesToday++;
            if (!lastTs || parsed.ts > lastTs) lastTs = parsed.ts;
          }
        }
      } catch { /* skip */ }
      totalFires += fires;
      totalFiresToday += firesToday;
      perAgent.push({
        agent,
        fires,
        firesToday,
        estimatedUsd: round(fires * perFire, 4),
        estimatedUsdToday: round(firesToday * perFire, 4),
        lastFireAt: lastTs,
      });
    }
  }
  perAgent.sort((a, b) => b.fires - a.fires);

  const todayUsd = totalFiresToday * perFire;

  return {
    generatedAt: new Date().toISOString(),
    perFireUsd: round(perFire, 6),
    totals: {
      fires: totalFires,
      firesToday: totalFiresToday,
      todayUsd: round(todayUsd, 4),
      // Naive projection: today's spend × 30. Honest for forward-looking
      // estimate as long as today is representative.
      thirtyDayUsd: round(todayUsd * 30, 2),
      // Worst-case anchor — simulator mixed-mode 30d, useful for headroom.
      monthAtFullRateUsd: 430.62,
    },
    perAgent,
    source: { dir: LOG_DIR, files },
    estimate: true,
  };
}

function round(n: number, places: number): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}
