# Eunomia

```
 ███████╗██╗   ██╗███╗   ██╗ ██████╗ ███╗   ███╗██╗ █████╗
 ██╔════╝██║   ██║████╗  ██║██╔═══██╗████╗ ████║██║██╔══██╗
 █████╗  ██║   ██║██╔██╗ ██║██║   ██║██╔████╔██║██║███████║
 ██╔══╝  ██║   ██║██║╚██╗██║██║   ██║██║╚██╔╝██║██║██╔══██║
 ███████╗╚██████╔╝██║ ╚████║╚██████╔╝██║ ╚═╝ ██║██║██║  ██║
 ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═╝
```

> *One brain. Many hands. No waste.*

A lean, browser-based command centre that runs a team of Claude Code agents from your terminal. One CEO thinks. Temporary workers execute. Everything streams live to `localhost:4600`. You stay in control.

Built because existing multi-agent tools burn 10x the tokens for the same output. Eunomia was designed from the ground up around token efficiency — three rounds of adversarial red-team review, 15 critics, stress-tested to a risk score of 15/125 before a single line of code was written.

![Dashboard](docs/screenshot.png)

---

## The idea

Most orchestrators treat AI agents like stateless contractors — full re-briefing every interaction, hundreds of tool definitions inflating every turn, session history ballooning across heartbeats. The result: your usage limits evaporate in minutes.

Eunomia flips it. Agents are employees, not contractors:

- **CEO persists.** One long-running session with auto-compaction. Context lives in files (SOUL.md, GOALS.md, MEMORY.md), not in bloated conversation history.
- **Workers are disposable.** Spawned for one task, scoped to one directory, killed on completion. Clean context every time.
- **7 tools, not 240.** The CEO gets exactly what it needs. ~1,200 tokens of tool overhead per turn.
- **TASKS.md is the board.** No database, no kanban UI, no drag-and-drop. A markdown file both human and AI read natively. Git-trackable for free.
- **Safety is not optional.** 13 guardrails ship in V1. Workers can't use Bash. Workers can't write outside their folder. Budget caps, timeouts, inactivity pause — all enforced at the SDK level, not by polite instructions.

---

## Get running

### You need

- Node.js 22+
- Claude Code CLI, authenticated (`claude --version`)

### Install

```bash
git clone https://github.com/phaddad90/eunomia.git
cd eunomia/app
npm install
```

### Start

```bash
npm run dev -- --project /path/to/your/code
```

Open **http://localhost:4600**. That's it.

Eunomia scans your project, auto-generates context files, launches the CEO, and opens the dashboard. You'll see the CEO terminal streaming live within seconds.

```
Options:
  --project <path>    Target project directory (required)
  --port <number>     Dashboard port (default: 4600)
  --model <name>      CEO model (default: claude-sonnet-4-6)
```

---

## How it works

```
localhost:4600 (browser)
       |
       | WebSocket + REST
       v
Eunomia Server ─────────────────────────────────
  |
  |── agent-adapter    SDK wrapper (spawn / kill / stream)
  |     |── CEO        persistent session, auto-compacting
  |     |── Workers    temporary, task-scoped, disposable
  |
  |── tasks            TASKS.md parser + in-memory cache
  |── mcp-server       7 tools exposed to CEO only
  |── heartbeat        adaptive interval (10m default, backs off)
  |── safety           13 guardrails, SDK-enforced
  |── metrics          usage analytics, daily reports
  |── logger           structured logs (pino, daily rotation)
  |
  v
Your Project ───────────────────────────────────
  |── PROJECT.md       mission + goals (auto-generated)
  |── TASKS.md         the board (CEO writes, human edits)
  |── ceo/
  |     |── SOUL.md    who the CEO is
  |     |── GOALS.md   what it's targeting
  |     |── MEMORY.md  what it remembers (50-line cap, rotated)
  |── workers/
        |── task-042/
              |── output/   work product
```

**The loop:** CEO reads its soul and goals. Checks the task board. Breaks work into tasks. Spawns a worker. Worker completes (or fails). CEO reviews. Repeat. You watch, intervene when needed, or walk away — the inactivity pause will stop spending after 60 minutes of silence.

---

## The dashboard

Three tabs. Always-visible status bar. Always-visible prompt input.

**Terminals** — Full-width xterm.js CEO terminal. Worker terminals as expandable pills below. Click to swap view, Back button to return.

**Tasks** — Live-rendered TASKS.md. Planned / Active / Done / Failed sections. Add tasks, retry failed ones, kill active workers — all inline.

**Status** — Per-agent cost breakdown, heartbeat info, safety guard status, today's metrics (tasks completed, success rate, spend, heartbeat skip rate).

**Status bar** — CEO state, worker count, today's spend. Goes amber at 80% budget, red at 100%.

---

## Configuration

Drop an `eunomia.config.json` in your project directory. Everything is optional — defaults are sane.

```json
{
  "safety": {
    "maxConcurrentWorkers": 3,
    "maxDailyBudgetUsd": 50,
    "maxWorkerRuntimeMinutes": 30,
    "maxRetries": 2,
    "inactivityPauseMinutes": 60,
    "heartbeatIntervalMinutes": 10,
    "maxCeoSessionHours": 8,
    "maxPlannedTasks": 20,
    "requireApprovalForSpawn": false,
    "workingHours": {
      "start": "09:00",
      "end": "22:00",
      "timezone": "Europe/London"
    }
  },
  "port": 4600,
  "ceoModel": "claude-sonnet-4-6"
}
```

---

## Safety

Thirteen guardrails. All ship in V1. Not negotiable.

| Guard | What happens | Default |
|-------|-------------|---------|
| Concurrency cap | Rejects spawn if at limit | 3 workers |
| Daily budget | Warns at 80%, hard stops at 100% | $50/day |
| Worker timeout | Kills worker, marks task failed | 30 min |
| Retry limit | Marks task failed, needs human | 2 retries |
| Inactivity pause | Pauses heartbeat when you're away | 60 min |
| Working hours | Pauses outside hours, auto-resumes | Off |
| Write isolation | Blocks Write/Edit outside worker dir | Always on |
| Bash blocked | Workers cannot use Bash. Period. | Always on |
| CEO session age | Saves memory, restarts fresh | 8 hours |
| CEO crash recovery | Auto-restarts, notifies dashboard | Always on |
| Spawn approval | Optional human approve/reject gate | Off |
| Orphan cleanup | Marks stale tasks failed on restart | Always on |
| Human kill | Dashboard kill button, preserves output | Always on |

Workers are sandboxed at the SDK level. `disallowedTools: ['Bash']` plus a `canUseTool` path guard on every Write/Edit. This isn't a suggestion in a prompt — it's a hard block in the runtime.

---

## Tuning your agents

Edit these in your project's `ceo/` folder:

**SOUL.md** — Who the CEO is. Personality, rules, decision-making style. Keep under 50 lines. Human-written context outperforms AI-generated by ~7% in controlled studies. Worth your time.

**GOALS.md** — KPIs and sprint targets. Update as your project evolves. The CEO reads this every session.

**PROJECT.md** — Auto-generated on first run from your README and package.json. Edit it to add what the scanner missed. This is the mission brief every agent sees.

Templates in `templates/` if you want a starting point.

---

## Metrics + analytics

Every event is tracked to `metrics.jsonl`:

- Heartbeat fired/skipped (with interval and token counts)
- Worker spawned/completed/killed (with model, duration, cost, success)
- Human interactions (prompts, pauses, kills, task edits)
- Cost milestones (25%, 50%, 80%, 100% of budget)
- CEO restarts (age limit, crash)

Daily reports auto-generate to `reports/YYYY-MM-DD.md` on shutdown.

```
GET /api/metrics/summary    JSON summary of today's session
GET /api/metrics/report     Markdown daily report
```

---

## Cost reality

No hand-waving. These are stress-tested estimates.

| Setup | Daily cost |
|-------|-----------|
| Opus CEO + Sonnet workers | $60 - $120 |
| Sonnet CEO + Sonnet workers | $30 - $70 |
| Sonnet CEO + Haiku workers | $20 - $50 |

For comparison: a single Claude Code session runs $5-15/day. Eunomia runs 4-6x that for multi-agent throughput. The alternative tools run 10x+.

---

## Tech

5 runtime deps. 0 client deps. No React. No database. No build step for the dashboard.

| | |
|---|---|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` |
| Server | Express 5 + ws |
| Terminals | xterm.js via CDN |
| Logs | pino |
| CSS | Vanilla, dark theme |
| Build | tsx (dev), tsup (prod) |

---

## Roadmap

**v1.1 — Sharper CEO**
- Model routing per-heartbeat (Sonnet for routine checks, Opus for strategic planning)
- Configurable cold-start prompt templates
- Worker output summarisation (CEO writes 200-word digest, raw output archived)

**v1.2 — Better visibility**
- Historical cost graph on Status tab (last 7 days)
- Worker success rate trend line
- Sound/browser notifications on worker completion and safety alerts
- Command palette in prompt input (`/pause`, `/status`, `/spawn`)

**v1.3 — Smarter workers**
- Sandboxed Bash for workers (restricted to output dir only)
- Worker-to-worker file handoff (output of task A becomes input for task B)
- Task dependency chains (task B blocked until task A completes)
- Git auto-commit on worker completion

**v2.0 — Multi-project**
- Project switching in dashboard
- Cross-project CEO memory
- Shared worker pool
- Team mode (multiple humans, role-based access)

**Future**
- Goal hierarchy (goals break into tasks, progress bars roll up)
- Confirmation mode (CEO proposes, human approves before execution)
- Plugin system for custom MCP tools
- Remote deployment (run Eunomia on a server, access from anywhere)

---

## License

MIT

---

Built by [Peter Haddad](https://github.com/phaddad90). Designed with Claude Opus 4.6 through three rounds of red-team review — because if you're going to let AI manage AI, you'd better stress-test it first.
