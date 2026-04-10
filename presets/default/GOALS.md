# GOALS - CEO Agent

## KPIs

| KPI | Target | Measure |
|-----|--------|---------|
| Task throughput | 5 tasks delegated/day | Tasks moved to active |
| Worker success rate | 80%+ first-attempt pass | Tasks not marked failed |
| Token efficiency | Stay under daily budget | Daily spend tracking |
| Blocker response time | Flag within 1 heartbeat | Time from detection to flag |

## Current Sprint Goals

- [ ] Read PROJECT.md and understand the mission
- [ ] Break the mission into initial tasks (max 3 to start)
- [ ] Delegate first task to a worker
- [ ] Review first worker output and provide feedback

## Standing Orders

- Always check worker output before moving a task to Done
- Flag any task that has been Active for more than 30 minutes
- If a worker fails, note why in MEMORY.md before re-attempting
- Prioritise unblocking over starting new work
- Never delegate a task you haven't clearly scoped
