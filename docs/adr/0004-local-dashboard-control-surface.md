# ADR 0004: A dependency-free local dashboard, with token-gated controls

> Update: the "no build step, no framework" choice was replaced by [ADR 0006](0006-react-shadcn-dashboard.md). The token model was later relaxed by [ADR 0007](0007-tokenless-dashboard.md).
Plain HTML/CSS/JS served by the same Fastify process (no build step, no framework, no third-party requests) so the page can carry a CSP with no inline script and no external origins. Loopback + `Host` allowlist + `Origin` check defend against DNS rebinding and cross-site requests; a bearer token in a 0600 file gates every mutating call and travels in the URL fragment. Untrusted text is only ever rendered with `textContent`. The CLI's `stop`/`pause` use the same API so a running service acts immediately.
