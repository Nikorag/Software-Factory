# 0014: Central hub on PostgreSQL + Redis, pull-based command delivery

## Status
Accepted

## Context
A central hub at `factory.nikorag.co.uk` must run as several Kubernetes replicas on the cluster's existing PostgreSQL and Redis, and deliver remote commands to local factories reliably, without executing a command twice when it isn't safe to.

## Decision
- A separate workspace package `hub/` with its own image. The local factory keeps SQLite; the hub does not share its code or schema.
- **PostgreSQL is the only source of truth.** Redis (BullMQ queue, pub/sub, rate limits) is reconstructible: `reconcile()` re-enqueues pending commands.
- **Transactional outbox**: command row + outbox row commit together; a relay enqueues afterwards. Enqueue is idempotent (`jobId = commandId`) and queue handlers are idempotent.
- **Pull delivery** (long-poll) with PostgreSQL leases instead of WebSockets: no connection ownership to track, any replica serves any request, Redis pub/sub only reduces latency.
- **Ack-gated execution**: a factory may execute only after the hub accepts its ack, which revocation/expiry/stale leases refuse. A non-repeatable command whose lease lapses after ack becomes `unknown` and is never re-run.
- Plain SQL migrations run by a dedicated Job under an advisory lock; replicas only verify the schema. Chosen over drizzle-kit to keep the hub independent of the SQLite-oriented tooling.
- Deployment is described in docs (Terraform-managed), not shipped as manifests.
- Liveness checks nothing external; readiness checks PostgreSQL, Redis and schema.

## Consequences
Latency is bounded by the poll/wake path, not a held socket. Delivery is at-least-once with execute-at-most-once enforced by lease + ack semantics, and the `repeatable` flag is the caller's declaration of safety.

## Addendum: one frontend, tunnelled
The hub serves the same built `web/` app as the local factory rather than maintaining a second dashboard; `api.ts` prefixes calls with a base the hub injects via a `<meta>` tag (empty locally). Dashboard calls are relayed to the factory over a Redis-only, execute-now-or-fail tunnel (the factory long-polls), deliberately *not* the durable command queue: a stale control action executing hours later is worse than a failed one. The factory, not the hub, decides what is remotely reachable (default-deny policy, separate opt-in, secrets and process control blocked).
