# Contributing

Node ≥ 22, pnpm. Before committing: `pnpm typecheck && pnpm lint && pnpm test` must pass.
Schema changes: edit `src/db/schema.ts`, run `pnpm db:generate`, commit the generated `drizzle/` migration.
Tests never need real credentials; external systems are behind adapter interfaces with test doubles.
Record significant decisions as ADRs in `docs/adr/`.
