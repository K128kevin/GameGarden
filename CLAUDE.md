@AGENTS.md

## Project notes

- Platform integrations live behind `PlatformConnector` in `src/platforms/types.ts`; register new ones in `src/platforms/registry.ts`.
- Only `src/services/publisher.ts` may publish, and only rows in `scheduled_actions` created by explicit user actions. Never add a path from the planner/LLM to publishing.
- Schema changes: edit `src/db/schema.ts`, then `npm run db:generate`.
- Checks: `npm run lint && npm run typecheck && npm test` (tests need `DATABASE_URL`).
