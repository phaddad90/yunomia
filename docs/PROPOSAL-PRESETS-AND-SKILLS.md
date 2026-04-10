# Proposal: Preset Agents + Premade Skills

## The Idea

Right now every Eunomia project starts with the same generic CEO. You write the SOUL.md yourself or leave the default. But different projects need fundamentally different leadership:

- A branding project needs a creative director, not an engineer
- A security audit needs a paranoid adversarial thinker
- A website build needs someone who thinks in components and pages
- An architecture project needs someone who thinks in systems and tradeoffs

And certain workflows repeat across projects — red-teaming, deployment, auditing, testing. These shouldn't be reinvented every time.

**Two features:**

1. **Preset Agents** — pre-built CEO personalities you pick at project init. Each one has a tailored SOUL.md, GOALS.md, and recommended model/config.
2. **Premade Skills** — callable workflows the CEO or human can invoke on demand. Like playbooks. "Run a red team." "Deploy to staging." "Generate a brand audit."

---

## Preset Agents

### How it works

```
eunomia/
  presets/
    default/
      SOUL.md
      GOALS.md
      config.json         # model, heartbeat, worker preferences
    branding/
      SOUL.md             # creative director persona
      GOALS.md            # brand-focused KPIs
      config.json         # opus for strategy, sonnet for workers
    website/
      SOUL.md             # fullstack lead, thinks in pages + components
      GOALS.md            # ship pages, responsive, accessible
      config.json
    app-dev/
      SOUL.md             # tech lead, thinks in services + APIs
      GOALS.md            # ship features, test coverage, CI/CD
      config.json
    copywriting/
      SOUL.md             # editorial director, voice + tone expert
      GOALS.md            # content quality, brand consistency
      config.json
    architecture/
      SOUL.md             # systems architect, tradeoff thinker
      GOALS.md            # design docs, ADRs, scalability
      config.json
    security/
      SOUL.md             # adversarial thinker, OWASP-fluent
      GOALS.md            # vuln count, fix rate, coverage
      config.json
```

### Selection

At project init:
```bash
npm run dev -- --project /path/to/code --preset branding
```

Or if no preset specified, prompt in the dashboard on first launch:
```
Choose a CEO preset:
  [Default]  [Branding]  [Website]  [App Dev]
  [Copywriting]  [Architecture]  [Security]  [Custom]
```

The preset's SOUL.md and GOALS.md get copied to `{project}/ceo/`. You can then edit them — they're yours. The preset is just the starting point.

### Preset config.json

```json
{
  "recommendedModel": "claude-opus-4-6",
  "heartbeatIntervalMinutes": 15,
  "maxConcurrentWorkers": 2,
  "workerModel": "sonnet",
  "description": "Creative director for brand strategy and identity work"
}
```

### Custom Presets

Save your current CEO config as a preset:
```
POST /api/presets/save   { name: "my-saas-preset" }
```

This copies `{project}/ceo/SOUL.md`, `GOALS.md`, and current safety config to `presets/{name}/`. Reusable across projects.

---

## Premade Skills

### How it works

Skills are structured workflows — more than a single prompt, less than a full feature. They have:
- A **trigger** (human clicks in UI, CEO calls via MCP, or scheduled)
- A **prompt template** with variables
- A **execution mode** (CEO handles it, spawn a dedicated worker, or spawn multiple workers)
- An **output location** (where results go)
- Optional **project-specific config** (deploy paths, API keys, etc.)

```
eunomia/
  skills/
    red-team/
      skill.json
      prompt.md
    deploy-ssh/
      skill.json
      prompt.md
    deploy-ftp/
      skill.json
      prompt.md
    brand-audit/
      skill.json
      prompt.md
    security-scan/
      skill.json
      prompt.md
    content-review/
      skill.json
      prompt.md
    test-suite/
      skill.json
      prompt.md
    code-review/
      skill.json
      prompt.md
```

### skill.json

```json
{
  "name": "Red Team Review",
  "description": "Spawn 3-5 specialist critics to review the current codebase",
  "icon": "shield",
  "mode": "multi-worker",
  "workers": [
    { "role": "Security Auditor", "model": "opus", "focus": "OWASP, auth, input validation" },
    { "role": "Architecture Critic", "model": "sonnet", "focus": "scalability, coupling, error handling" },
    { "role": "UX Reviewer", "model": "sonnet", "focus": "usability, accessibility, error states" }
  ],
  "output": "reports/red-team-{date}.md",
  "compiledBy": "ceo",
  "config": {}
}
```

### prompt.md

```markdown
You are a {{role}}. Your focus area is: {{focus}}.

Review the codebase at {{projectPath}}. Check every file relevant to your focus area.

Report:
1. Critical issues (must fix)
2. Important issues (should fix)
3. Minor issues (nice to fix)

For each issue: file path, line number, what's wrong, how to fix it.
Rate confidence: HIGH (certain) or MEDIUM (likely).

Be thorough but concise. Under 1500 words.
```

### Execution Modes

**`ceo`** — The CEO handles the skill itself. Good for planning/strategy skills.
- "Generate an architecture decision record"
- "Write a project status report"

**`single-worker`** — Spawns one worker with the skill prompt. Good for focused tasks.
- "Security scan this codebase"
- "Review all content for brand voice"

**`multi-worker`** — Spawns multiple workers in parallel, CEO compiles results. Good for red-teaming, multi-perspective reviews.
- "Red team this feature"
- "Review this PR from 3 angles"

**`script`** — Runs a shell command (with safety guards). Good for deployment.
- "Build and deploy to staging"
- "Run test suite and report"

### Configurable Skills (per-project)

Some skills need project-specific config. For example, `deploy-ssh` needs:
```json
{
  "host": "my-server.com",
  "user": "deploy",
  "path": "/var/www/mysite",
  "buildCmd": "npm run build",
  "outputDir": "out"
}
```

This config lives in the project folder at `{project}/skills/deploy-ssh.config.json`. The skill template references these values via `{{config.host}}`, `{{config.path}}`, etc.

On first invoke of a skill that needs config, the dashboard prompts the user to fill in the required fields.

### Dashboard Integration

**Skills tab** (new tab, or section in Status tab):
```
┌────────────────────────────────────────────┐
│  Skills                                     │
│                                             │
│  [Red Team]  [Security Scan]  [Code Review] │
│  [Deploy SSH]  [Brand Audit]  [Test Suite]  │
│                                             │
│  Click to configure and run.                │
└────────────────────────────────────────────┘
```

Clicking a skill:
1. Shows description + config form (if needed)
2. "Run Skill" button
3. Progress indicator while workers run
4. Results rendered when complete

### CEO MCP Integration

Add one MCP tool:
```
run_skill: { skillName: string, config?: object }
```

The CEO can invoke skills autonomously. Example: CEO encounters a security concern and calls `run_skill({ skillName: "security-scan" })`. A worker spawns with the security scan prompt and reports back.

---

## Proposed Presets (V1)

### 1. Default
The current generic CEO. Plans, delegates, reviews. Good for any project.

### 2. Branding
Creative director. Thinks in brand identity, voice, visual language, audience. Delegates to copywriters and designers. Reviews for brand consistency.

### 3. Website
Fullstack lead. Thinks in pages, components, responsive breakpoints, SEO. Delegates frontend and content tasks. Reviews for user experience.

### 4. App Dev
Tech lead. Thinks in services, APIs, databases, CI/CD. Delegates to backend and frontend engineers. Reviews for architecture and test coverage.

### 5. Copywriting
Editorial director. Thinks in voice, tone, clarity, persuasion. Delegates content creation. Reviews for readability and brand alignment.

### 6. Architecture
Systems architect. Thinks in tradeoffs, scalability, coupling, data flow. Delegates research and prototyping. Reviews for technical soundness.

### 7. Security
Adversarial thinker. OWASP-fluent. Thinks in attack surfaces, trust boundaries, blast radius. Delegates audits. Reviews for vulnerabilities.

---

## Proposed Skills (V1)

### 1. Red Team
Spawns 3-5 critics with different specialisms. CEO compiles a unified report.

### 2. Security Scan
Single worker reviews the codebase for OWASP top 10, auth issues, input validation, secrets exposure.

### 3. Code Review
Single worker reviews recent changes (git diff) for bugs, logic errors, style issues.

### 4. Deploy (SSH)
Configurable: host, user, path, build command. Runs build, uploads via SSH, verifies.

### 5. Deploy (FTP)
Configurable: host, user, path, build command. Runs build, uploads via FTP.

### 6. Brand Audit
Single worker reviews all content/copy files against brand voice guidelines.

### 7. Content Review
Single worker checks all markdown/text content for readability, E-E-A-T, SEO basics.

### 8. Test Suite
Runs the project's test command, parses results, reports failures with context.

---

## Build Estimate

### Phase 1: Presets (1-2 sessions)
- Write 7 preset SOUL.md + GOALS.md + config.json files
- Add `--preset` CLI flag to init
- Preset selector in dashboard on first launch
- "Save as Preset" endpoint

### Phase 2: Skills Framework (2-3 sessions)
- Skill loader (reads skills/ directory)
- Skill runner (handles ceo/single-worker/multi-worker/script modes)
- Template variable interpolation
- MCP tool: `run_skill`
- Dashboard: Skills section with config forms and run buttons

### Phase 3: Skill Library (1-2 sessions)
- Write 8 skill definitions (skill.json + prompt.md)
- Per-project config system
- Results rendering in dashboard

**Total: 4-7 sessions**

---

## Open Questions

1. **Should presets be switchable mid-project?** Replacing SOUL.md mid-session would reset the CEO's understanding. Probably better to require a restart.

2. **Should skills be versioned?** If we update a skill prompt, existing projects keep their version until they update. Or do they always use the latest?

3. **Should the CEO be able to create new skills?** The CEO could write a skill.json + prompt.md to the skills directory, making it reusable. Powerful but risky — needs approval mode.

4. **How do script-mode skills interact with safety?** Running `npm run build` needs Bash access, which is blocked for workers. Script skills would need a separate execution path with explicit human approval.
