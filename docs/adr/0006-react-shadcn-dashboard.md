# ADR 0006: The dashboard is a React + shadcn/ui app, built to static files

Supersedes the "no build step, no framework" part of [ADR 0004](0004-local-dashboard-control-surface.md). Everything else in 0004 still holds.

**Decision.** The dashboard lives in `web/` (Vite, React, TypeScript, Tailwind, shadcn/ui components copied into `web/src/components/ui`). `pnpm web:build` produces static files in `web/dist`, which the same Fastify process serves. There is no Node runtime, SSR or CDN in the loop.

**Why.** The job page now draws a live flow chart of the real 20-stage pipeline, including the routes where a review sends work back. That, plus the answer form and step filtering, outgrew hand-built DOM code.

**Security properties kept.**
- Same CSP: `script-src 'self'; style-src 'self'; default-src 'none'`. The build emits external script and CSS only, no inline code, no third-party origins, no web fonts from a CDN.
- Same loopback, `Host`/`Origin` and bearer-token model. The token still arrives in the URL fragment and is removed immediately.
- Untrusted text (tickets, agent output, logs) is rendered only as React text children. A test fails the build if the source uses `dangerouslySetInnerHTML`, `innerHTML`, `eval` and the like, and another renders hostile payloads and asserts no elements, handlers or `javascript:` links appear.
- The server serves only `index.html` and files directly under `assets/` whose names match `[\w.-]+`.

**Costs.** A frontend dependency tree (React, Radix, Tailwind, Vite) in a security-sensitive tool; `web/dist` must be built (`pnpm web:build`, run automatically by `pnpm test` and `pnpm build`). Radix's Select injects a small inline `<style>` for its scrollbar, which the CSP blocks. That is cosmetic only and the CSP is deliberately not loosened.
