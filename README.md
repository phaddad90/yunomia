# PrintPepper Mission Control

> Local browser command room for the PrintPepper AI agent fleet.

A lean Express + WebSocket app that mounts at `http://localhost:4600`, reads the live `/admin/board` state, and gives Peter (CEO) a single-pane view of the seven-agent fleet — without manual terminal-relay between sessions.

## What it does (v0.1)

- Live Kanban mirror of `https://admin.printpepper.co.uk/admin/board`, updated via WebSocket and an audit-poll fallback.
- Six agent cards (SA, AD, WA, DA, QA, WD) with traffic-light status (⚫ idle · 🟡 standby · 🟢 running · 🔴 blocked) derived from current ticket assignments.
- **Drop a Note** panel: text + voice (Web Speech API) + screenshot drop zone → posts a fresh `triage` ticket to the CEO inbox in seconds.
- **Copy prompt** button on any ticket — clipboard gets the relay one-liner that pastes straight into an agent terminal.
- Side panel: full ticket body, references, recent comments, fast `start`/`handoff`/`done` transitions.
- Today's stats, deploy bundle preview, daily report tab.

## Hard constraints

- **Zero calls to `api.anthropic.com`.** Mission Control runs on Peter's Claude Code subscription only — no per-token billing. All upstream traffic goes to `https://admin.printpepper.co.uk/api/admin/*` via the agent-token auth pattern (`x-pp-agent-token` + `x-pp-agent-id`).
- Server binds `127.0.0.1` only. No `0.0.0.0`. No remote exposure.
- No database. State lives in PrintPepper's platform DB; Mission Control is read-through with a thin write layer for notes and transitions.
- No subagent spawning. Peter opens his six agent terminals; Mission Control is the dashboard, not a session manager.
- Light mode only. Zinc + pepper-red accents. No dark mode, no purples, no greens (except the status check).

## Run it

```bash
cd app
npm install
export AGENT_API_TOKEN=<32-byte hex token>     # provisioned by SA
export PP_AGENT_CODE=TA                         # default; falls back to TA
npm run dev
```

Open `http://localhost:4600`.

| Env var               | Default                                  | What it does                                        |
|-----------------------|------------------------------------------|-----------------------------------------------------|
| `AGENT_API_TOKEN`     | (required)                               | Agent service token. Never commit.                  |
| `PP_AGENT_CODE`       | `TA`                                     | Identifies who Mission Control authenticates as.    |
| `PP_API_BASE`         | `https://admin.printpepper.co.uk`        | PrintPepper API base.                               |
| `PP_AUDIT_POLL_MS`    | `8000`                                   | Audit poll cadence.                                 |
| `PP_WEBHOOK_SECRET`   | _(unset → webhook receiver disabled)_    | HMAC secret for `POST /webhook/board-event`.        |

`AGENT_API_TOKEN` may also be supplied via a local `mission-control.config.json` next to where you run the server. **Don't commit that file.**

## How it talks to PrintPepper

```
browser  ──ws──▶  Mission Control (localhost:4600)  ──https──▶  admin.printpepper.co.uk
                            │
                            └── audit poll (every 8s) → broadcast deltas → browser re-renders
```

Two delta sources, in order of preference:

1. **Webhooks** (`POST /webhook/board-event`, HMAC-validated). Reachable only when you tunnel (e.g. ngrok) since the webhook fires from prod.
2. **Audit poll** (server-side, never browser-side) → `GET /api/admin/audit?since=<ts>` every 8s. Always-on fallback.

Browser ↔ server traffic is over a single WebSocket so the dashboard re-renders within a poll cycle of any prod-side change.

## Layout

```
┌──────────────────── Mission Control ─────────────────────┐
│ brand          [● live]                  [you are: 🛠 TA]│
├──────────┬────────────────────────────────┬──────────────┤
│ Agents   │  Board / Activity / My Inbox / │ Drop a Note  │
│  🟧 SA   │  Reports                       │  text/voice  │
│  🟦 AD   │                                │  screenshot  │
│  🟪 WA   │  ┌─backlog─┬─triage─┬─assigned-┤              │
│  🟨 DA   │  │ ticket  │ ticket │ ticket   │ CEO inbox    │
│  🟥 QA   │  │ ticket  │        │          │  PH-037 …    │
│  🌐 WD   │  └─────────┴────────┴──────────┘              │
│ Today    │                                │              │
│ Bundle   │                                │              │
└──────────┴────────────────────────────────┴──────────────┘
```

## Tech

| | |
|---|---|
| Server | Express 5 + ws + pino |
| Browser | Vanilla JS, no framework, no build step |
| Build | tsx (dev), tsup (prod) |
| Auth | `x-pp-agent-token` + `x-pp-agent-id` headers |

Five runtime deps. No React. No database. No SDK that bills tokens.

## License

MIT
