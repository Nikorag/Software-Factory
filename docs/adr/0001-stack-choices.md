# ADR 0001: Stack choices
- **better-sqlite3 + Drizzle** over `node:sqlite`: Drizzle supports it maturely; prebuilt binary verified on Node 26.
- **TypeScript 5.9** pinned: typescript-eslint does not yet support TS 7.
- **Loopback-only server**: host is a Zod literal, not configurable.
- **Separate data dir** (`~/.software-factory`) so runtime state never lives in a repo agents can touch.
- **Fastify first, dashboard later**: the API came first; the dashboard (ADR 0006) followed.
