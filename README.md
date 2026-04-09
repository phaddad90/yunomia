# Eunomia

> *Greek goddess of good order and lawful conduct.*

A browser-based command centre for orchestrating Claude Code agent sessions. One persistent CEO agent plans and delegates work. Temporary worker agents are spawned for specific tasks and killed on completion. A shared `TASKS.md` file is the coordination layer. A dashboard gives the human full visibility, cost tracking, and intervention controls.

![Dashboard](docs/screenshot.png)

## Why This Exists

Multi-agent orchestration tools like Paperclip AI suffer from runaway token consumption -- 10M+ tokens/day for work a single agent could do in 1M. The root causes are well-documented: session history accumulation via `--resume`, oversized skill files loaded every heartbeat, and hundreds of MCP tool definitions inflating every turn.

Eunomia takes the opposite approach: a persistent CEO with a compact context (SOUL.md + GOALS.md + MEMORY.md), temporary workers with clean per-task sessions, and exactly 7 MCP tools instead of 240. The result is 4-6x a single agent's throughput at $40-100/day with mixed models, not $300/day per agent.

See [docs/RESEARCH.md](docs/RESEARCH.md) for the full token efficiency analysis and Paperclip comparison.

## How It Works

```
Browser (localhost:4600)
    |
    | WebSocket + REST
    v
Eunomia Server (Node.js, single process)
    |
    |-- agent-adapter.ts ---- SDK abstraction layer (swappable)
    |   |-- CEO Session       (persistent, auto-compacting)
    |   |-- Worker Sessions   (temporary, task-scoped)
    |
    |-- tasks.ts ------------ TASKS.md read/write + in-memory cache
    |-- mcp-server.ts ------- 7 MCP tools for CEO
    |-- ws-relay.ts ---------- WebSocket per terminal (xterm.js)
    |-- heartbeat.ts --------- Adaptive interval scheduler
    |-- safety.ts ------------ 13 guardrails (see below)
    |-- metrics.ts ----------- Usage analytics + daily reports
    |-- logger.ts ------------ Structured logging (pino, daily rotation)
    |
    v
Project Folder
    |-- PROJECT.md         Mission and goals (auto-generated, human-editable)
    |-- TASKS.md           Shared task list (CEO writes, human edits)
    |-- ceo/
    |   |-- SOUL.md        CEO personality and rules
    |   |-- GOALS.md       Current objectives
    |   |-- MEMORY.md      CEO's working memory (50-line cap, auto-rotated)
    |-- workers/
        |-- task-042/
            |-- SOUL.md    Read-only context from template
            |-- output/    Work product
```

**CEO agent** reads its SOUL.md, GOALS.md, and MEMORY.md on startup. It plans work, creates tasks in TASKS.md, and spawns workers via MCP tools. An adaptive heartbeat prompts the CEO at configurable intervals (default 10 minutes), skipping beats when nothing has changed and doubling the interval after consecutive no-ops.

**Worker agents** are spawned for a single task, scoped to their own directory, with no Bash access and write-isolation enforced by the SDK. When the work is done, the worker reports back and is killed. Output is reviewed by the CEO.

**TASKS.md** is the single source of truth. Both the CEO and the human can read and edit it directly. No kanban board, no database -- just a markdown file with inline metadata for model, priority, and budget. Git-trackable for free.

## Installation

### Prerequisites

- Node.js 22+
- npm
- Claude Code CLI installed and authenticated (`claude --version` should work)

### Setup

```bash
git clone https://github.com/phaddad90/eunomia.git
cd eunomia/app
npm install
```

No build step required for development.

## Quick Start

```bash
cd app
npm run dev -- --project /path/to/your/code
```

Open [http://localhost:4600](http://localhost:4600).

The server will:

1. Scan your project directory for README, package.json, and existing docs
2. Auto-generate `PROJECT.md` with discovered context
3. Create `ceo/` folder with default SOUL.md and GOALS.md
4. Create an empty `TASKS.md`
5. Launch the dashboard and start the CEO agent

A banner will remind you: *"Using default configuration. Edit PROJECT.md, ceo/SOUL.md, or ceo/GOALS.md to improve results."*

## Configuration

Create `eunomia.config.json` in your project directory (optional -- all fields have sensible defaults):

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

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--project <path>` | Target project directory (required) | -- |
| `--port <number>` | Dashboard port | `4600` |
| `--model <name>` | CEO model | `claude-sonnet-4-6` |

```bash
npm run dev -- --project /projects/apprintable --port 4600 --model claude-opus-4-6
```

## Project Structure

### What gets created in your project folder

```
your-project/
  PROJECT.md                Auto-generated project summary
  TASKS.md                  Shared task list
  eunomia.config.json       Safety and behaviour config (optional)
  audit.jsonl               Append-only task mutation log
  metrics.jsonl             Usage analytics (token costs, worker lifecycle)
  ceo/
    SOUL.md                 CEO personality (editable)
    GOALS.md                Current objectives (editable)
    MEMORY.md               CEO's working memory (auto-managed)
    MEMORY-archive.md       Older memory entries (auto-rotated)
  workers/
    task-042/               Created per task
      SOUL.md
      output/
  logs/
    eunomia-2026-04-09.log  Daily structured logs
  reports/
    2026-04-09.md           Daily usage reports (auto-generated)
```

## Safety Guardrails

Safety ships in V1. It is not optional.

| Guard | Trigger | Action | Default |
|-------|---------|--------|---------|
| Concurrency cap | `spawn_worker` called | Reject if at limit | 3 workers |
| Daily budget | Any token spend | Warn 80%, pause 100% | $50/day |
| Worker timeout | Worker exceeds runtime | Kill, mark failed | 30 min |
| Retry limit | Task retried N times | Mark failed, need human | 2 retries |
| Inactivity pause | No human interaction | Pause heartbeat | 60 min |
| Working hours | Outside configured hours | Pause all, auto-resume | Off |
| Worker write scope | Write/Edit outside worker dir | Block via SDK | Always on |
| Worker Bash blocked | Any Bash tool use | Block via `disallowedTools` | Always on |
| CEO session age | Session exceeds max hours | Save memory, restart | 8 hours |
| CEO crash recovery | Session dies unexpectedly | Auto-restart, notify | Always on |
| Spawn approval | `requireApprovalForSpawn` on | Dashboard approve/reject | Off |
| Orphan cleanup | Server restart | Mark active tasks failed | Always on |
| Human kill | Dashboard kill button | Kill process, mark failed | Always on |

Worker isolation is the most critical guardrail. Workers cannot use Bash and cannot write outside their own directory, enforced at the SDK level.

## Customisation

Edit these files in your project's `ceo/` directory:

- **SOUL.md** -- CEO personality, communication style, decision-making rules. Keep under 50 lines.
- **GOALS.md** -- Current objectives and KPIs. Update as your project evolves.
- **PROJECT.md** -- Auto-generated on first run. Edit to add context the scanner missed.

Research shows human-written context files improve agent success by ~4%. AI-generated context hurts by ~3%. Invest time here.

Templates are in the `templates/` directory for reference.

## Dashboard

Three tabs, always-visible status bar, always-visible prompt input.

**Terminals** (default) -- Full-width CEO terminal. Worker terminals appear as clickable pills below. Click to expand (replaces CEO view with Back button).

**Tasks** -- Rendered TASKS.md with planned/active/done/failed sections. Add Task button for human-created tasks. Inline edit controls.

**Status** -- Per-agent breakdown (model, session age, tokens, cost). Cost split. Safety guard status. Heartbeat info.

**Status bar** (always visible) -- CEO state, worker count, today's spend. Green/amber/red based on budget usage.

## Cost Estimates

| Scenario | CEO Model | Worker Model | Daily Cost |
|----------|-----------|--------------|------------|
| Full Opus CEO | Opus | Sonnet | $60 - $120 |
| Mixed CEO | Sonnet + Opus | Sonnet | $30 - $70 |
| Budget mode | Sonnet | Sonnet + Haiku | $20 - $50 |

| System | Tokens/Day | Cost/Day |
|--------|-----------|----------|
| Single Claude Code | 500K - 1M | $5 - $15 |
| Eunomia (mixed) | 4M - 8M | $40 - $100 |
| Paperclip AI | 10M+ | $300+/agent |

## MCP Tools (CEO only)

| Tool | Purpose |
|------|---------|
| `tasks_list` | Read TASKS.md filtered by status |
| `tasks_create` | Add a task to Planned |
| `tasks_update` | Update status, notes, or priority |
| `spawn_worker` | Create a temporary worker for a task |
| `worker_status` | Check worker runtime and spend |
| `kill_worker` | Force-stop a worker |
| `list_workers` | List all active workers |

Total tool definition overhead: ~1,200 tokens per turn.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` (fallback: CLI via `node-pty`) |
| Server | Express 5 + ws |
| Terminal UI | xterm.js (CDN) |
| Logging | pino (daily rotation) |
| Styling | Vanilla CSS, dark theme |
| Build | tsup (dev: tsx) |

Runtime dependencies: 5. Client dependencies: 0.

## License

MIT

## Credits

Built by Peter Haddad. Designed with Claude Opus 4.6. Three rounds of red team review (15 critics total). Validated through adversarial stress-testing across token economics, architecture, UX, chaos engineering, and strategic viability.
