# Eunomia Product Brief (v3)

> Revised 2026-04-10 after three-specialist red team review.

## What We're Building

A subscription product that gives Claude users a visual command centre for AI agents. Desktop app is the entry point - cheap, low friction, gets users in. Cloud version is the upgrade - higher margin, zero installs, premium features.

The desktop app is a marketing tool for the cloud version.

## Target User

Developers and technical founders who understand software but prefer a dashboard over a terminal. They have Claude Pro/Max or an API key. They have projects. They just don't want to manage agents from the command line.

Not non-technical users. Not people who've never coded. The target is: "I know what I want built, I just hate the terminal."

## Pricing Strategy

### Desktop App - The Hook

Priced to acquire users, not to maximise revenue. The goal is volume + conversion to cloud.

Exact price TBD pending competitor analysis once we have a shippable app. Ballpark: $5-15/mo. Low enough to be an impulse buy. High enough to filter out people who won't use it.

What they get:
- Tauri native app (Mac + Windows)
- All features: presets, skills, safety guardrails, metrics, voice, images
- Auto-updates
- Community support (Discord/GitHub)
- Single project at a time

### Cloud Version - The Business

Priced for margin. This is where the money is.

| Tier | Price | What's included |
|------|-------|-----------------|
| Cloud | $19-29/mo | Hosted instance at yourname.eunomia.app. Zero installs. We manage everything. |
| Cloud Pro | $49-79/mo | Multi-project, team access, Telegram/Slack channels, priority support |
| Enterprise | Custom | Self-hosted on customer's infrastructure, SLA, dedicated support |

Cloud advantages over desktop (the upsell pitch):
- No machine dependency - runs 24/7 even when your laptop is off
- No Node.js/Claude Code setup - we handle it
- Access from any device (phone, tablet, work machine)
- Telegram/Slack channels (prompt your CEO from your phone)
- Multi-project support (switch between projects in one dashboard)
- Team features (invite collaborators, role-based access)
- Automatic backups of project state
- Priority support

The conversion path: user downloads desktop app for $X/mo, hits limitations (laptop needs to stay on, single project, no mobile access), sees the cloud upgrade card in the dashboard, clicks upgrade.

## Architecture

### Desktop App (Tauri)

```
Tauri App (~100MB)
  |-- Native window (OS webview)
  |-- Bundled Node.js runtime (sidecar)
  |-- Eunomia server (runs locally)
  |-- Dashboard in webview
  |
  |-- First launch:
  |     1. claude login (opens browser for Anthropic OAuth)
  |     2. Pick a project folder (native file picker)
  |     3. Choose a preset (or use default)
  |     4. Go
  |
  |-- No npm, no terminal, no CLI knowledge needed
  |-- Auto-updates via Tauri built-in updater
  |-- License key validation on startup
```

Important correction from red team: we use the Agent SDK (`@anthropic-ai/claude-agent-sdk`), NOT the Claude Code CLI. The SDK is already bundled in node_modules. We only need the CLI's `claude login` command for authentication. No `npm install -g` step needed.

### Cloud Version

```
eunomia.app
  |-- Landing page + auth
  |-- Stripe checkout
  |-- Instance manager
  |
  v
Per-User Container (Docker, 1GB RAM)
  |-- Eunomia server
  |-- User's project files (persistent volume)
  |-- Claude auth (encrypted API key, decrypted at boot)
  |-- Accessible at username.eunomia.app
```

Hosting economics (1GB RAM per user):
- Cost per user: ~$5-7/mo (Hetzner, 3-4 users per CX22)
- At $29/mo: ~75% margin
- At $79/mo: ~90% margin

### API Key Security (Cloud)

User provides their Anthropic API key. Stored encrypted (AES-256, key derived from user's account password). Decrypted only inside their container at runtime. Key never leaves their container. If they change their password, key is re-encrypted.

This is how Cursor, Windsurf, and every hosted AI tool handles it.

## Build Sequence

| Phase | What | Notes |
|-------|------|-------|
| 1 | Landing page + waitlist | Validate interest before building |
| 2 | Show HN + Reddit + Twitter launch | Open-source repo is the marketing |
| 3 | Stripe integration | License key generation + validation |
| 4 | Tauri desktop app (Mac first) | Bundles Node.js, native file picker, auto-updater |
| 5 | Code signing pipeline | Apple notarization + Windows cert |
| 6 | Windows build | After Mac is stable |
| 7 | Competitor pricing analysis | Set desktop price based on market data |
| 8 | Telegram channel integration | Differentiator for cloud tier upsell |
| 9 | Cloud hosted version | Docker per-user, subdomain routing, API key custody |
| 10 | Multi-project + team features | Cloud Pro tier justification |

## Go-to-Market (30-Day Plan)

### Days 1-3: Launch
- Record 90-second demo GIF (not video - GIFs autoplay)
- Show HN: "Eunomia - multi-agent orchestration that cuts token waste by 80%"
- Post video to r/ClaudeAI (not repo link - non-devs don't click GitHub)
- GIF to Twitter/X
- DM 5 AI YouTubers (Matt Wolfe, AI Advantage, etc.) with free access + Loom

### Days 4-7: Content
- "Eunomia vs Paperclip vs raw Claude Code" comparison post (Dev.to + own site)
- LinkedIn founder story: "I automated my dev workflow with AI agents"
- Join 3 Facebook AI groups, start commenting helpfully

### Days 8-14: Community
- Reply to every HN/Reddit comment
- Ship one improvement based on feedback
- Build r/ClaudeAI karma (answer questions, no links)
- Twitter thread showing a real build session with cost breakdown

### Days 15-21: Second wave
- 5-minute YouTube walkthrough targeting "Claude Code tutorial" searches
- Product Hunt launch (Tuesday 12:01 AM PT)
- Dev.to: "13 safety guardrails for AI agents"

### Days 22-30: Proof
- Collect testimonials from first 10-20 users
- Add social proof to landing page
- "Week 4 update" Twitter thread with real numbers
- First user spotlight

### Landing Page
- Hero: "Watch AI agents build your project. Live."
- 90-second autoplay GIF above the fold
- 3 steps: Install. Point. Watch.
- Social proof: "Built by a founder running a $1.4M company"
- "Try the demo" button (read-only sandbox or interactive video)
- Waitlist capture (expect 5-15% conversion from cold, 20-40% from warm HN)

### Where to find users
- r/ClaudeAI (primary - your exact audience)
- YouTube AI creators (reach non-devs who watch tutorials)
- Facebook groups (AI Tools for Business, etc.)
- Twitter/X (threads showing real sessions)
- LinkedIn (founder story posts)
- NOT r/programming, r/artificial (wrong audience)

## Revenue Projections (Conservative)

Assumes 5% free-to-paid conversion, blended average price.

| Milestone | Free | Desktop Paid | Cloud Paid | MRR | Timeline |
|-----------|------|-------------|------------|-----|----------|
| Launch | 100 | 5 | 0 | ~$50 | Month 1 |
| Traction | 500 | 25 | 5 | ~$400 | Month 3 |
| Growth | 2000 | 80 | 20 | ~$1,400 | Month 6 |
| Scale | 5000 | 150 | 100 | ~$4,400 | Month 12 |

Revenue accelerates as cloud tier launches and desktop users upgrade.

## Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Anthropic changes/deprecates Agent SDK | Critical | Agent adapter layer. Multi-provider abstraction. Ship features they won't build. |
| Anthropic builds their own dashboard | High | Speed. Community. Features (Telegram, teams, presets, skills). |
| Paperclip launches hosted version | Medium | Token efficiency + UX + safety are differentiators. |
| Low free-to-paid conversion | Medium | Desktop is the hook. Cloud convenience drives upgrades. |
| Support burden from non-technical users | Medium | Repositioned target to developers-who-prefer-dashboards. Self-service docs. |
| macOS notarization / Windows SmartScreen | Medium | $400/yr certs. SmartScreen reputation builds with installs. |
| API key custody liability (cloud) | Medium | AES-256 encryption. Per-container isolation. Documented risk. |

## Future Features (Post-Launch)

- **Channels:** Telegram bot (MVP), Slack app, Discord bot. Prompt CEO from phone.
- **Self-development:** Eunomia runs against its own repo. CEO creates features, workers implement, human approves PRs.
- **Marketing automation:** Reddit keyword scanner for market intelligence. Draft responses for human review.
- **Onboarding templates:** "Build me a landing page", "Add auth to my app", "Write tests for this repo". Pre-built first-run prompts.
- **Churn prevention:** Weekly email digests, saved configurations, prompt history.
- **Multi-provider:** Support Codex, Gemini CLI alongside Claude. Platform, not wrapper.

## Open Decisions

1. **Domain:** eunomia.app? eunomia.dev? Different name entirely?
2. **Trademark:** "Eunomia" is used by a Mastodon moderation tool. Check before investing in brand.
3. **Desktop price:** TBD after competitor analysis. Ballpark $5-15/mo.
4. **GitHub repo:** Keep public (marketing) or go private (protect IP)? Recommendation: public with a commercial license (BSL or similar).
5. **First cloud host:** Hetzner (cheapest) or Railway (easiest container management)?
