# Red Team: Product Strategy Feedback

> Three specialists reviewed the product brief on 2026-04-10.

## Verdicts

| Reviewer | Rating | One-line |
|----------|--------|----------|
| SaaS Founder | **Viable** | Right market, wrong price, wrong target definition. Fix three things and it's strong. |
| Platform Engineer | **Viable with blockers** | Desktop works. Hosted has an API key custody problem. SDK dependency is existential. |
| Growth Marketer | **Viable** | Concrete 30-day plan. Lead with token efficiency, not "visual command centre." |

---

## Consensus: Fix These 5 Things

### 1. Pricing is too low

All three critics agree. $5/mo attracts tire-kickers. Comparable tools charge $15-39/mo.

**Revised pricing:**
- Free: open-source, self-hosted
- Desktop: $19/mo
- Hosted: $39/mo
- Team: $79/mo

### 2. Target is "developers who prefer dashboards", not "non-technical users"

The SaaS founder was blunt: non-technical users will generate support tickets and never understand the output. The growth marketer noted they're unreachable via HN/Reddit anyway.

**Revised target:** Developers and technical founders who understand software but prefer a GUI over terminal. They have Claude Pro/Max. They have projects. They just hate managing agents manually.

### 3. Desktop first, hosted second

Solo founder building both in parallel ships neither. Desktop has zero ops burden, near-zero hosting costs, and validates demand. Hosted comes after 50 paying desktop users.

### 4. SDK dependency is existential - not medium risk

The platform engineer flagged: the Claude Agent SDK is v0.2.x, unstable, no public API guarantee. If Anthropic ships a breaking change or deprecates it, the product is dead.

**Mitigations:**
- Start abstracting toward multi-provider now (architecture, not code)
- Ship fast - build features Anthropic won't (Telegram, team workflows, presets)
- Make switching costs high
- Monitor Anthropic's roadmap actively

### 5. The brief confuses CLI vs SDK

The product uses the Agent SDK (`@anthropic-ai/claude-agent-sdk`), not the Claude Code CLI. The desktop app does NOT need to install the CLI. It needs the SDK (already a npm dependency) and the auth command (`claude login`). This simplifies the install story significantly.

---

## Technical Blockers (from Platform Engineer)

| Blocker | Severity | Notes |
|---------|----------|-------|
| API key custody for hosted tier | High | Users paste API keys, store encrypted (AES-256), decrypt into container at boot. Document the risk. |
| Code signing (Mac notarization + Windows SmartScreen) | High | $400/yr for certs. First ~500 Windows installs still see SmartScreen warning. |
| Container RAM | Medium | 512MB is too low. 1GB minimum per user. Economics: ~60% margin instead of 75%. |
| SDK stability | Critical | v0.2.x, no public API contract. Existential if Anthropic breaks it. |

---

## Go-to-Market (from Growth Marketer)

### 30-Day Launch Plan

**Days 1-3:** Record 90-second demo GIF. Show HN: "Eunomia - multi-agent orchestration that doesn't burn your token budget." Same day: post video to r/ClaudeAI. GIF to Twitter/X. DM 5 AI YouTubers.

**Days 4-7:** Write "Eunomia vs Paperclip vs raw Claude Code" comparison post. LinkedIn founder story. Join 3 Facebook AI groups.

**Days 8-14:** Reply to every HN/Reddit comment. Ship one improvement from feedback. Build r/ClaudeAI karma (answer questions, no links).

**Days 15-21:** 5-minute YouTube walkthrough. Product Hunt launch (Tuesday 12:01 AM PT). Dev.to post on safety guardrails.

**Days 22-30:** Collect testimonials. Add to landing page. Twitter thread with real numbers. First user spotlight.

### Landing Page

- Hero: "Watch AI agents build your project. Live." (not "Your AI team. One click.")
- 90-second autoplay GIF above the fold (not video - GIFs play without clicking)
- Social proof (even "Built by a solo founder running a $1.4M company")
- "Try the demo" button with a read-only sandbox or interactive video
- Waitlist capture at 5-15% conversion from cold traffic, 20-40% from warm HN post

### Channels to Non-Technical Users

- YouTube AI creators (Matt Wolfe, AI Advantage, Skill Leap AI) - DM them with free hosted access
- Facebook groups ("AI Tools for Business", "ChatGPT & AI for Non-Techies")
- LinkedIn founder story posts
- Twitter/X threads showing real sessions with cost breakdowns

### Conversion Reality

- Industry standard free-to-paid: 2-5%
- At 2000 free users with 5% conversion = 100 paid users
- At $29 average price = $2,900 MRR
- The hosted tier is the conversion engine - convenience sells

---

## Revenue Model (Revised)

| Milestone | Free Users | Paid Users | Avg Price | MRR | Timeline |
|-----------|-----------|------------|-----------|-----|----------|
| Launch | 100 | 5 | $29 | $145 | Month 1 |
| Traction | 500 | 25 | $29 | $725 | Month 3 |
| Growth | 1500 | 75 | $29 | $2,175 | Month 6 |
| Scale | 5000 | 250 | $29 | $7,250 | Month 12 |

At 5% conversion, $29 average. Conservative.

---

## What's Missing (Consensus)

1. **Onboarding templates** - "Build me a landing page", "Add auth to my app", "Write tests for this repo". Pre-built prompts that demonstrate value in the first 5 minutes.
2. **Churn prevention** - weekly email digests, saved configurations, prompt history.
3. **Legal/trademark check** - "Eunomia" is used by a Mastodon moderation tool. Verify before investing in the brand.
4. **Multi-provider abstraction** - support Codex/Gemini CLI as architecture, not just Claude. This makes you a platform, not a wrapper. Wrappers die.

---

## Recommended Build Order (Revised)

1. Landing page + waitlist (validate)
2. Show HN + Reddit + Twitter launch
3. Stripe integration ($19/$39 tiers)
4. Tauri desktop app (Mac first, Windows second)
5. Code signing pipeline
6. Telegram channel integration (v2 differentiator)
7. Server-hosted version (after 50+ paying desktop users)
8. Marketing automation
