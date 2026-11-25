# ADR 0007: The dashboard needs no token; the token remains for the CLI and scripts

Supersedes the "every mutating call needs the bearer token" part of [ADR 0004](0004-local-dashboard-control-surface.md).

**Decision.** A change is accepted if it carries the bearer token (`<dataDir>/control-token`, for the CLI and scripts) **or** it is a genuine same-origin browser request from the dashboard: our own `Origin`, an `X-Factory-UI: 1` header, and no cross-site `Sec-Fetch-Site`. There is no read-only mode and nothing to paste.

**Why it is still safe from the web.** A page on another site cannot set `X-Factory-UI` without a CORS preflight (the server never grants one), and browsers attach `Origin` and `Sec-Fetch-Site` themselves, so a page cannot forge them. The loopback-only, `Host` allowlist (DNS rebinding) and `Origin` checks are unchanged.

**What this gives up.** Another process on the machine, or another user on a shared Mac, can send those headers and so can use the dashboard API: pause, stop, answer a held job, and (with Settings) change the commands the factory runs in its sandbox. Choose this on a machine you alone use. The token path remains if you later want to require it.
