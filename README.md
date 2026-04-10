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

---

## The idea

We started with a question: *why does multi-agent AI orchestration burn through token limits in minutes?*

We dug into the leading orchestrators. Read the GitHub issues, the Reddit complaints, the source code. Found three root causes:

1. **Session accumulation.** Every heartbeat resumes the full conversation history. By heartbeat 10, you're carrying millions of tokens of stale context.
2. **Skill file bloat.** Tens of thousands of tokens of instruction files and tool definitions loaded on every cycle, even when the agent needs 10% of them.
3. **No memory, just re-briefing.** Agents don't learn. They get told everything, every time.

So we asked: *what if agents were employees, not contractors?*

Contractors need a full brief every engagement. Employees build institutional knowledge. They have a role (SOUL.md), targets (GOALS.md), and working memory (MEMORY.md). They read files when they need context instead of being force-fed everything on every turn.

The result:

- **CEO persists.** One long-running session with auto-compaction. Context lives in files, not in bloated conversation history.
- **Workers are disposable.** Spawned for one task, scoped to one directory, killed on completion. Clean context every time.
- **7 tools, not 240.** ~600 tokens of tool overhead per turn.
- **TASKS.md is the board.** No database. A markdown file both human and AI read natively.
- **Safety is not optional.** 13 guardrails enforced at the SDK level, not by polite instructions in a prompt.

---

## Get running

**Prerequisites:** Node.js 22+, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

```bash
git clone https://github.com/phaddad90/eunomia.git
cd eunomia/app
npm install
npm run dev -- --project /path/to/your/code
```

Open **http://localhost:4600**. Eunomia scans your project, generates context files, and starts the CEO. You'll see the terminal streaming within seconds.

| Option | Default |
|--------|---------|
| `--project <path>` | required |
| `--port <number>` | 4600 |
| `--model <name>` | claude-sonnet-4-6 |

---

## How it works

You point Eunomia at a project folder. It spins up a CEO agent in your browser. The CEO reads its soul and goals, checks the task board, and starts planning.

When something needs building, it spawns a temporary worker — a separate Claude Code session sandboxed to its own directory. The worker does the job and dies. The CEO reviews the output, updates the board, and moves on.

You watch it all live. Prompt the CEO when you want to steer. Pause when you walk away. Kill workers that go sideways.

```
                    ┌─────────────────────────────────┐
                    │     localhost:4600 (browser)     │
                    │                                  │
                    │  Terminals │ Tasks │ Status       │
                    │  ┌──────────────────────────┐   │
                    │  │  > You: build the API     │   │
                    │  │  CEO: On it. Spawning...  │   │
                    │  └──────────────────────────┘   │
                    │  [$4.20 today]  [Pause]  [Stop]  │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────┴──────────────────┐
                    │        Eunomia Server            │
                    │                                  │
                    │  agent-adapter ── SDK wrapper     │
                    │    ├── CEO (persistent session)   │
                    │    └── Workers (spawn & kill)     │
                    │                                  │
                    │  tasks ────── TASKS.md cache      │
                    │  mcp-server ─ 7 tools for CEO    │
                    │  heartbeat ── adaptive (10m-60m)  │
                    │  safety ───── 13 SDK guardrails   │
                    │  metrics ──── analytics + reports │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────┴──────────────────┐
                    │         Your Project             │
                    │                                  │
                    │  PROJECT.md ── the mission        │
                    │  TASKS.md ──── the board          │
                    │  ceo/                             │
                    │    ├── SOUL.md ── who it is       │
                    │    ├── GOALS.md ─ what it targets │
                    │    └── MEMORY.md  what it learned │
                    │  workers/                         │
                    │    └── task-042/                  │
                    │         └── output/ ── the work   │
                    └─────────────────────────────────┘
```

**The CEO loop:** Check the board. Plan. Delegate. Review. Write lessons. The heartbeat starts at 10 minutes, doubles after 3 idle cycles, caps at 60 minutes, resets instantly when work arrives.

**The human loop:** Watch the terminal. Prompt when needed. Walk away — the inactivity pause stops spending after 60 minutes. Come back, hit resume, carry on.

---

## Safety

Thirteen guardrails. All SDK-enforced. Not prompt-based suggestions.

| Guard | What happens | Default |
|-------|-------------|---------|
| Concurrency cap | Rejects spawn if at limit | 3 workers |
| Daily budget | Warns at 80%, hard stops at 100% | $50/day |
| Worker timeout | Kills worker, marks task failed | 30 min |
| Retry limit | Marks task failed, needs human | 2 retries |
| Inactivity pause | Pauses heartbeat when you're away | 60 min |
| Working hours | Pauses outside hours, auto-resumes | Off |
| Write isolation | Blocks Write/Edit outside worker dir | Always on |
| Bash blocked | Workers cannot use Bash | Always on |
| CEO file guard | CEO cannot modify its own SOUL.md or GOALS.md | Always on |
| CEO session age | Saves memory, restarts fresh | 8 hours |
| CEO crash recovery | Auto-restarts, notifies dashboard | Always on |
| Spawn approval | Optional human approve/reject gate | Off |
| Orphan cleanup | Marks stale tasks failed on restart | Always on |

Workers are sandboxed at the SDK level: `disallowedTools: ['Bash']` plus a `canUseTool` path guard on every Write/Edit/MultiEdit that returns `{ behavior: 'deny' }` for anything outside the worker's folder.

The CEO is also guarded — it cannot rewrite its own rules. Server binds to `127.0.0.1` only. Safety config updates are validated with type and range bounds.

---

## Configuration

Drop an `eunomia.config.json` in your project directory. Everything is optional — [see full config reference](docs/BRIEF.md#configuration).

Key settings: `maxConcurrentWorkers` (1-10), `maxDailyBudgetUsd` (1-500), `heartbeatIntervalMinutes` (1-60), `requireApprovalForSpawn` (true/false), `workingHours` ({ start, end, timezone }).

---

## Tuning your agents

Edit these in your project's `ceo/` folder:

**SOUL.md** — Who the CEO is. Keep under 50 lines. Human-written context outperforms AI-generated by ~7% in controlled studies.

**GOALS.md** — KPIs and sprint targets. Update as your project evolves.

**PROJECT.md** — Auto-generated on first run. Edit to add what the scanner missed.

---

## Metrics

Every event is tracked to date-partitioned `metrics/metrics-YYYY-MM-DD.jsonl`:

- Heartbeat fired/skipped, with interval and token counts
- Worker spawned/completed/killed, with model, duration, cost, success rate
- Human interactions, cost milestones, CEO restarts, session summaries

Daily reports auto-generate to `reports/YYYY-MM-DD.md` on shutdown. The CEO writes a "lessons learned" entry to MEMORY.md covering what worked and what to change.

```
POST /api/daily-review      Trigger CEO lessons learned (no shutdown needed)
GET  /api/metrics/summary   JSON summary of today's session
GET  /api/metrics/report    Markdown daily report
```

---

## Cost

Honest numbers. Stress-tested.

| Setup | Daily cost |
|-------|-----------|
| Opus CEO + Sonnet workers | $60 - $120 |
| Sonnet CEO + Sonnet workers | $30 - $70 |
| Sonnet CEO + Haiku workers | $20 - $50 |

A single Claude Code session runs $5-15/day. Eunomia runs 4-6x that for multi-agent throughput.

---

## Tech

5 runtime deps. 0 client-side deps. No React. No database.

| | |
|---|---|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` |
| Server | Express 5 + ws |
| Terminals | xterm.js via CDN |
| Logs | pino |
| Build | tsx (dev), tsup (prod) |

---

## Status

**Current version: v1.0** — fully functional, 5 rounds of red-team review, actively in use.

## Roadmap

**v1.1 — Sharper CEO** *(next)*
- Model routing per-heartbeat (Sonnet for routine checks, Opus for strategic planning)
- Worker output summarisation (CEO writes digest, raw output archived)
- Configurable cold-start prompt templates

**v1.2 — Better visibility**
- Historical cost graph on Status tab (last 7 days)
- Worker success rate trend line
- Browser notifications on worker completion and safety alerts
- Command palette in prompt input (`/pause`, `/status`, `/spawn`)

**v1.3 — Smarter workers**
- Sandboxed Bash for workers (restricted to output dir only)
- Task dependency chains (task B blocked until task A completes)
- Worker-to-worker file handoff (output of A becomes input for B)
- Git auto-commit on worker completion

**v2.0 — Multi-project**
- Project switching in dashboard
- Cross-project CEO memory
- Shared worker pool

**v3.0 — Team mode**
- Multiple humans, role-based access
- Goal hierarchy with progress rollup
- Confirmation mode (CEO proposes, human approves)
- Plugin system for custom MCP tools
- Remote deployment

---

## License

MIT

---

Built by [Peter Haddad](https://github.com/phaddad90). Designed with Claude Opus 4.6. Five rounds of red-team review (20+ specialist critics) across token economics, architecture, UX, chaos engineering, and security.
