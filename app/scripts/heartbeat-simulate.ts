#!/usr/bin/env node --import tsx
/**
 * heartbeat-simulate.ts — closed-form model of `/loop heartbeat-check` cost.
 *
 * Gives a number tonight without burning 3 hours of subscription quota.
 * The empirical run (PH-045 step 2) is what makes the numbers canonical;
 * this script makes the order-of-magnitude clear before that.
 *
 * Usage:
 *   npm run heartbeat-simulate                      # default mix
 *   npm run heartbeat-simulate -- --active 0.4      # 40% of heartbeats find queue=1
 *   npm run heartbeat-simulate -- --hours 24        # 24h projection
 *   npm run heartbeat-simulate -- --json            # machine-readable
 *
 * Numbers come from the heartbeat-check skill contract: one curl, one log
 * line, one ScheduleWakeup, no file reads, no codebase touches. All values
 * are sensitivity-knobbed via flags so disagreements stay productive.
 */

interface Args {
  hours: number;
  active: number;       // fraction of heartbeats with queue == 1
  agents: number;       // fleet size
  cachedIn: number;     // tokens read from prompt cache per heartbeat
  freshIn: number;      // fresh input tokens per heartbeat
  out: number;          // output tokens per heartbeat
  activeIntervalSec: number;
  idleIntervalSec: number;
  // Sonnet 4.6 list pricing (USD per Mtok), tweakable for Opus/Haiku runs
  priceCachedRead: number;
  priceFresh: number;
  priceOut: number;
  json: boolean;
}

function parseArgs(): Args {
  const a: Args = {
    hours: 3,
    active: 0.40,
    agents: 7,
    cachedIn: 3500,
    freshIn: 500,
    out: 150,
    activeIntervalSec: 90,
    idleIntervalSec: 1200,
    priceCachedRead: 0.30,   // $/Mtok
    priceFresh: 3.00,        // $/Mtok
    priceOut: 15.00,         // $/Mtok
    json: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    const set = (n: keyof Args) => { (a as unknown as Record<string, number | boolean>)[n] = Number(v); i++; };
    if (k === '--hours') set('hours');
    else if (k === '--active') set('active');
    else if (k === '--agents') set('agents');
    else if (k === '--cached-in') set('cachedIn');
    else if (k === '--fresh-in') set('freshIn');
    else if (k === '--out') set('out');
    else if (k === '--active-interval') set('activeIntervalSec');
    else if (k === '--idle-interval') set('idleIntervalSec');
    else if (k === '--price-cached') set('priceCachedRead');
    else if (k === '--price-fresh') set('priceFresh');
    else if (k === '--price-out') set('priceOut');
    else if (k === '--json') a.json = true;
  }
  return a;
}

function fireRatePerHour(a: Args): number {
  // Mixed cadence: weighted average of active (90s) and idle (1200s) intervals.
  const activePerHour = 3600 / a.activeIntervalSec;
  const idlePerHour = 3600 / a.idleIntervalSec;
  return a.active * activePerHour + (1 - a.active) * idlePerHour;
}

function project(a: Args) {
  const fph = fireRatePerHour(a);
  const totalFiresPerAgent = fph * a.hours;
  const fleetFires = totalFiresPerAgent * a.agents;

  const tokensInPerFire = a.cachedIn + a.freshIn;
  const tokensOutPerFire = a.out;
  const tokensPerFire = tokensInPerFire + tokensOutPerFire;

  const fleetTokensIn = fleetFires * tokensInPerFire;
  const fleetTokensOut = fleetFires * tokensOutPerFire;
  const fleetTokensTotal = fleetTokensIn + fleetTokensOut;

  // USD via list API pricing (Sonnet defaults). Subscription users can ignore
  // the dollars and look at the token totals; this gives a price-anchored
  // reference for the conversation.
  const usd =
    (a.cachedIn * fleetFires) / 1_000_000 * a.priceCachedRead +
    (a.freshIn * fleetFires) / 1_000_000 * a.priceFresh +
    (a.out * fleetFires) / 1_000_000 * a.priceOut;

  const usdPerAgentDay = (usd / a.agents) * (24 / a.hours);
  const usdPerFleetDay = usd * (24 / a.hours);
  const usdPerFleetMonth = usdPerFleetDay * 30;

  return {
    inputs: a,
    perAgent: {
      firesInWindow: round(totalFiresPerAgent, 1),
      firesPerHour: round(fph, 2),
      tokensInWindow: Math.round(totalFiresPerAgent * tokensPerFire),
    },
    fleet: {
      agents: a.agents,
      firesInWindow: Math.round(fleetFires),
      tokensInWindow: Math.round(fleetTokensTotal),
      tokensInWindowFmt: fmtTokens(fleetTokensTotal),
      tokensInPerFire,
      tokensOutPerFire,
    },
    usd: {
      inWindow: round(usd, 4),
      perFleetDay: round(usdPerFleetDay, 2),
      perAgentDay: round(usdPerAgentDay, 2),
      perFleetMonth: round(usdPerFleetMonth, 2),
    },
  };
}

function round(n: number, places: number): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

function scenarios(args: Args) {
  return {
    idle:  project({ ...args, active: 0.00 }),
    mixed: project({ ...args, active: 0.40 }),
    active: project({ ...args, active: 1.00 }),
  };
}

function render(s: ReturnType<typeof scenarios>, args: Args): string {
  const lines: string[] = [];
  lines.push(`PrintPepper heartbeat cost projection — closed-form model`);
  lines.push(`(Sonnet 4.6 list pricing · agents=${args.agents} · window=${args.hours}h · per-fire: ${args.cachedIn}+${args.freshIn} in / ${args.out} out)`);
  lines.push('');
  lines.push(`scenario | active% | fleet fires | fleet tokens | $ in window | $ / fleet-day | $ / fleet-month`);
  lines.push(`-------- | ------- | ----------- | ------------ | ----------- | ------------- | ---------------`);
  for (const [name, p] of Object.entries(s)) {
    lines.push(
      `${name.padEnd(8)} | ${(p.inputs.active * 100).toFixed(0).padStart(7)}% | ${String(p.fleet.firesInWindow).padStart(11)} | ${p.fleet.tokensInWindowFmt.padStart(12)} | $${p.usd.inWindow.toFixed(4).padStart(10)} | $${p.usd.perFleetDay.toFixed(2).padStart(12)} | $${p.usd.perFleetMonth.toFixed(2).padStart(14)}`,
    );
  }
  lines.push('');
  lines.push(`Per-agent ($/day, mixed): $${s.mixed.usd.perAgentDay.toFixed(2)}`);
  lines.push(`Subscription notes:`);
  lines.push(`  Sonnet Max 5h window ≈ 200k tokens. Mixed-mode 24h fleet = ${s.mixed.fleet.tokensInWindowFmt.replace('M','M').replace('k','k')} → ~${(s.mixed.fleet.tokensInWindow / 200_000).toFixed(1)}× a single 5h window.`);
  lines.push(`  Idle-only 24h fleet would burn ${s.idle.fleet.tokensInWindowFmt} — comfortably inside one Pro account.`);
  return lines.join('\n');
}

const args = parseArgs();
const out = scenarios(args);

if (args.json) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  process.stdout.write(render(out, args) + '\n');
}
