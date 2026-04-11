# Worker Reliability Improvements

## Problem Statement

From real usage data across multiple sessions:
- 38 task failures from 19 workers (2:1 fail ratio)
- Most common failure: worker produces 0 tokens and hangs
- Workers that do produce output often miss the mark on scope
- No verification that output is useful before marking done
- CEO has to manually "retire" failed tasks

## Root Causes

### 1. Workers hang at 0 tokens (SDK level)
The Claude Agent SDK session connects but never starts streaming. This could be:
- API rate limiting (too many concurrent sessions)
- Auth token issues
- The SDK waiting for a permission prompt that never comes
- Network-level timeouts

### 2. Task scope too large
"Website Redesign" is not a worker-sized task. Workers excel at micro-tasks:
- Good: "Write Nav.tsx with mobile hamburger menu, brand colours from brand-spec.md"
- Bad: "Redesign the entire website"

### 3. Worker context is too thin
The worker SOUL.md template is ~120 tokens of generic instructions. The worker has no idea:
- What the project looks like (file structure, tech stack)
- What conventions to follow (naming, formatting, patterns)
- What other workers have already done
- What the CEO expects as output format

### 4. No output verification
A worker can "complete" with zero files in its output directory.

## Fixes

### Fix 1: Spawn health check (immediate)
After spawning a worker, check for first token within 60 seconds. If no tokens, kill immediately and retry (don't wait 5 minutes for the nudge). This catches the "connected but dead" pattern fast.

Implementation: in agent-adapter.ts, start a 60-second timer on spawn. If no output callback fires, kill the session. Reset the timer on first token.

### Fix 2: Richer worker SOUL.md (immediate)
Inject project context into the worker SOUL. The MCP server already knows:
- The project path (can scan for key files)
- The CEO's SOUL.md (knows the project conventions)
- Recent completed tasks (knows what's already done)

Add to the worker SOUL template:
- Project tech stack (read from package.json)
- Key file paths (from PROJECT.md file map)
- What other tasks have been completed (from TASKS.md done section)
- Output format requirements ("write one file per component, include comments")

### Fix 3: CEO task decomposition guidelines
Add to the CEO SOUL.md:
- "Break tasks into units a single worker can complete in under 10 minutes"
- "Each task should produce 1-3 files maximum"
- "Include acceptance criteria: what files should exist when done"
- "Specify the model: haiku for simple edits, sonnet for new code, opus for architecture"

### Fix 4: Output verification before marking done
In the worker completion handler, check:
- Does the output/ directory have any files?
- Are the files non-empty?
- Do the files match what the task description asked for?

If output is empty, mark as "failed - no output" instead of "done".

### Fix 5: Worker warm-up prompt
Before sending the real task, send a quick warm-up:
"Read the project structure at {{projectPath}}. List the key files. Then proceed with your task."

This forces the worker to actually engage with the codebase before attempting the task. If it can't even list files, it's broken - kill it early.

### Fix 6: Retry with escalation
When a task fails:
- First retry: same model, same scope
- Second retry: escalate to a higher model (sonnet -> opus)
- Third retry: mark failed, flag for human with "tried 3 times, needs manual intervention"

### Fix 7: Worker output streaming to TASKS.md
Update the task notes in real-time as the worker produces output:
- "Worker running... 500 tokens"
- "Worker running... 2K tokens, writing files"
- "Worker completed - 3 files written"

This gives the CEO (and the human) visibility into what workers are doing without opening their terminal.

## Priority Order

1. Output verification (prevents false "done") - 30 min
2. Spawn health check 60s (catches dead sessions fast) - 1 hour
3. Richer worker SOUL.md with project context - 1 hour
4. CEO task decomposition guidelines - 15 min (SOUL.md edit)
5. Worker warm-up prompt - 30 min
6. Retry with escalation - 1 hour
7. Live task notes - 1 hour
