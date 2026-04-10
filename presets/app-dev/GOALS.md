# GOALS - Tech Lead Agent

## KPIs

| KPI | Target | Measure |
|-----|--------|---------|
| Test coverage | > 80% on new code | Coverage report |
| Build stability | Zero broken builds | CI pass rate |
| API contract compliance | 100% match to spec | Contract test results |
| Task completion rate | 3-5 engineering tasks/day | Tasks moved to done |

## Current Sprint Goals

- [ ] Read PROJECT.md and map the system architecture
- [ ] Define data models and API contracts for core entities
- [ ] Set up project scaffold (framework, testing, linting, CI)
- [ ] Delegate first backend task with clear input/output spec
- [ ] Review first worker output for correctness and test coverage

## Standing Orders

- Every service must have health check and error handling middleware
- Database migrations are versioned and reversible
- No direct DB access from route handlers - use a service layer
- Log structured JSON, not string concatenation
- Flag any task that requires credentials or infrastructure changes
- TypeScript strict mode. No implicit any.
