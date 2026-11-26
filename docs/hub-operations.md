# Software Factory Hub: deployment and operations

The hub (`hub/`) is the central, multi-replica service deployed at `factory.nikorag.co.uk`. It is separate from the local factory (`src/`): different image, different dependencies (no Electron/SQLite), and it uses the cluster's **existing PostgreSQL and Redis**. The image contains the application only.

## What lives where

| Store | Holds | If lost |
|---|---|---|
| **PostgreSQL** (authoritative) | users, passkey credentials, sessions, orgs/memberships, factories, factory credential hashes, permissions, projects/jobs/workflows, factory events, remote commands + outbox, audit events, push subscriptions, notification prefs/deliveries | restore from backup |
| **Redis** (transient) | BullMQ dispatch queue, pub/sub (command wake-ups, live dashboard), rate-limit counters | nothing is lost: pending work is re-enqueued from PostgreSQL |

## Remote command lifecycle

`pending → queued → delivered → acknowledged → succeeded | failed`, plus `expired`, `revoked`, `unknown`.

1. **Authorised** inside the creating transaction (org role or factory permission).
2. **Persisted** in `remote_commands`, with an `outbox` row **in the same transaction**. Nothing touches Redis before commit, so a command can't be committed-but-lost, or enqueued-but-uncommitted.
3. **Enqueued**: the outbox relay (every replica, `FOR UPDATE SKIP LOCKED`) pushes to the BullMQ queue with `jobId = commandId` (duplicates collapse). The queue worker moves `pending → queued` and publishes a wake-up on Redis pub/sub.
4. **Delivered**: factories pull with long-poll `GET /v1/factory/commands/next?wait=25`. The claim is one atomic SQL statement against PostgreSQL, so it works even if Redis is down, and two replicas never hand out the same command. Each delivery carries a lease token.
5. **Acknowledged**: `POST …/ack` is the factory's *permission to execute*. It is refused (`409`, `execute:false`) if the command was revoked, expired, or the lease is stale. A factory that gets a refusal must not run it. Re-acking extends the lease (heartbeat for long commands).
6. **Executed** by the factory, **7. result** via `POST …/result`, recorded once; replays are no-ops.

Recovery and at-most-once rules (`reconcile()`, every `RECONCILE_INTERVAL_MS`, safe on all replicas):
- Redis lost its queue → pending/queued commands are re-enqueued from PostgreSQL.
- Delivered but never acked → redelivered (it cannot have run).
- Acked, lease lapsed, **not** `repeatable` → parked as `unknown`, **never re-run**. The original holder may still report its true result later. `repeatable: true` commands are re-run.
- Past `expires_at` before ack → `expired`. Revoked commands are never delivered.

Because the factory pulls over HTTP, there is no connection-ownership problem: any replica can serve any factory or dashboard request, and the wake-up reaches whichever replica holds the long-poll via Redis pub/sub (with a 3s database re-check as fallback).

## Configuration

All via environment variables: non-sensitive in the ConfigMap, sensitive in a Secret. The process refuses to start on invalid config and names the offending variables (never their values).

| Variable | Req. | Default | Notes |
|---|---|---|---|
| `PUBLIC_URL` | ✔ | | `https://factory.nikorag.co.uk` |
| `PORT` / `HOST` / `LOG_LEVEL` | | 8080 / 0.0.0.0 / info | |
| `DATABASE_URL` 🔒 | ✔ | | `postgres://user:pass@host:5432/db` |
| `DATABASE_POOL_MAX` | | 10 | per replica; replicas × this < Postgres `max_connections` |
| `DATABASE_IDLE_TIMEOUT_MS` / `_CONNECT_TIMEOUT_MS` / `_STATEMENT_TIMEOUT_MS` | | 30000 / 5000 / 15000 | |
| `DATABASE_SSL` / `DATABASE_SSL_CA` | | disable | `require` or `verify-full` (+CA PEM) |
| `REDIS_URL` 🔒 | ✔ | | `redis://[:pass@]host:6379/0`; `rediss://` enables TLS |
| `REDIS_USERNAME` / `REDIS_PASSWORD` 🔒 | | | override URL credentials (ACL users) |
| `REDIS_TLS_CA` / `REDIS_TLS_REJECT_UNAUTHORIZED` | | / true | |
| `REDIS_KEY_PREFIX` | | sfhub | namespaces keys on a shared Redis |
| `SETUP_TOKEN` 🔒 | ✔ | | ≥24 chars. One-time secret that authorises creating the **first** user. After that, setup is closed regardless |
| `SESSION_SECRET` 🔒 | ✔ | | ≥32 chars; HMAC key for session tokens. Rotating it signs everyone out |
| `FACTORY_TOKEN_PEPPER` 🔒 | ✔ | | ≥32 chars; HMAC key for factory token hashes. Rotating it invalidates all factory tokens |
| `SESSION_TTL_SECONDS` | | 1209600 | |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` | ✔ | | RP ID `factory.nikorag.co.uk`; changing it orphans existing passkeys |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 🔒 / `VAPID_SUBJECT` | ✔ | | generate: `node dist/cli.js vapid-generate`; subject `mailto:` or `https:` |
| `COMMAND_DEFAULT_TTL_SECONDS` / `COMMAND_LEASE_SECONDS` / `COMMAND_MAX_DELIVERY_ATTEMPTS` | | 3600 / 60 / 5 | |
| `POLL_MAX_WAIT_SECONDS` / `RATE_LIMIT_PER_MINUTE` | | 25 / 300 | rate limit is per client IP, via Redis, fails open |
| `RECONCILE_INTERVAL_MS` / `OUTBOX_INTERVAL_MS` | | 15000 / 1000 | |
| `SHUTDOWN_DRAIN_MS` / `SHUTDOWN_TIMEOUT_MS` | | 5000 / 25000 | |
| `RUN_BACKGROUND` | | true | `false` = API-only replica |

🔒 = Secret. Local dev template: `hub/.env.example`.

## Build, tag, publish

Build from the **repo root** (the workspace lockfile is shared). With podman (on macOS the binary is `/opt/podman/bin/podman` and `podman machine` must be running):

```bash
VERSION=0.2.0
podman build -f hub/Dockerfile \
  --build-arg VERSION=$VERSION --build-arg REVISION=$(git rev-parse --short HEAD) \
  -t ghcr.io/nikorag/software-factory-hub:$VERSION .
podman push ghcr.io/nikorag/software-factory-hub:$VERSION
```

Multi-stage build: frozen-lockfile install → `tsc` → `pnpm deploy --prod` → distroless Node runtime (~185 MB), user `nonroot` (uid/gid 65532), no shell. Deploy an explicit version tag, never `latest`. In practice CI does this for you: see the next section.

The container's default command is `node dist/cli.js serve`. Other commands: `migrate`, `migrate-status`, `vapid-generate`, `healthcheck` (pass as container args, e.g. `dist/cli.js migrate`).

## Publishing from CI (GHCR, multi-arch)

`.github/workflows/hub-image.yml`:
- **Pull requests** touching `hub/**` build the image (amd64) to catch breakage; nothing is pushed.
- **Merge to `main`** builds `linux/amd64` + `linux/arm64` (QEMU/buildx) and pushes one multi-arch manifest to `ghcr.io/nikorag/software-factory-hub` with two tags: `<version>` (from `hub/package.json`; moves with each main build until you bump it) and `sha-<commit>` (immutable). **Pin `sha-<commit>` in Terraform** for reproducible deploys and clean rollbacks.
- It uses the built-in `GITHUB_TOKEN`; no secrets to add. New GHCR packages are **private** by default: either make the package public (Package settings → Change visibility), or give k3s a pull secret (`kubernetes_secret` of type `kubernetes.io/dockerconfigjson` with a GitHub PAT that has `read:packages`, referenced by `image_pull_secrets`).

## First run (create your user)

1. Open `https://factory.nikorag.co.uk`. With no users yet it shows **Set up your hub**.
2. Enter the `SETUP_TOKEN` secret, your email and name, then create a passkey. This is the only way to create a user and the only time the token is used; once a user exists, setup is closed (the endpoint returns 403 even with the right token).
3. Sign-in is **passkey-only**: no passwords exist anywhere. Registration and login both require user verification (biometric/PIN) and a discoverable credential. Use **Add passkey** to enrol a second device straight away: the last passkey cannot be removed, and there is no recovery flow. If you lose every passkey, recovery is operator-side (delete the rows from `users`/`passkey_credentials` in PostgreSQL to re-open setup).
4. **Add a factory** (name it) to get an **API key**, shown once. Put it in your local factory with `software-factory hub connect --url https://factory.nikorag.co.uk` (see `docs/hub-client.md`). Reporting is off in a local factory until you do this. Rotate or revoke the key from the factory's page at any time.

The WebAuthn relying-party ID must stay `factory.nikorag.co.uk` and the origin must match the URL you browse to exactly (HTTPS required, except `localhost`).

## Deploying with Terraform

No manifests are shipped; declare these resources with the `kubernetes` provider (or `kubectl`/`helm` provider if you prefer). Use the same names everywhere.

**1. Config (`kubernetes_config_map`)**: non-sensitive env vars from the table above, at minimum:
`NODE_ENV=production`, `PORT=8080`, `PUBLIC_URL=https://factory.nikorag.co.uk`, `WEBAUTHN_RP_ID=factory.nikorag.co.uk`, `WEBAUTHN_ORIGIN=https://factory.nikorag.co.uk`, `VAPID_SUBJECT=mailto:…`, and optionally `LOG_LEVEL`, `DATABASE_POOL_MAX`, `DATABASE_SSL`, `REDIS_KEY_PREFIX`.

**2. Secret (`kubernetes_secret`)**, keys exactly: `DATABASE_URL`, `REDIS_URL`, `SETUP_TOKEN`, `SESSION_SECRET`, `FACTORY_TOKEN_PEPPER`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (plus `REDIS_PASSWORD` / `REDIS_TLS_CA` / `DATABASE_SSL_CA` if used). Source the values from your secret store or Terraform variables marked `sensitive = true`; generate with `openssl rand -base64 48` (setup token/session/pepper) and `node dist/cli.js vapid-generate` (VAPID). Mind that values passed through Terraform land in its state: use an encrypted remote backend. Keep the pepper/session secrets stable across applies (use `lifecycle { ignore_changes }` or `random_password` resources), as rotating them signs everyone out / invalidates factory tokens.

**3. Migration Job (`kubernetes_job_v1`)**, run on every release *before* the Deployment is updated:
- image `…/software-factory-hub:<version>`, args `["dist/cli.js", "migrate"]`, `env_from` the ConfigMap and Secret.
- `restart_policy = "Never"`, `backoff_limit = 3`, `active_deadline_seconds = 600`, `ttl_seconds_after_finished = 86400`.
- Name it with the version (e.g. `software-factory-hub-migrate-0-2-0`) so each release gets a fresh Job, `wait_for_completion = true`, and make the Deployment `depends_on` it. This is the only thing that migrates; replicas never do.

**4. Deployment (`kubernetes_deployment_v1`)**:
- `replicas = 2` (stateless). Strategy RollingUpdate with `max_unavailable = 0`, `max_surge = 1`.
- Container: same image tag, args `["dist/cli.js", "serve"]`, port 8080 named `http`, `env_from` ConfigMap + Secret.
- Resources: requests `cpu 100m`, `memory 192Mi`; limit `memory 384Mi`.
- `termination_grace_period_seconds = 45` (must exceed `SHUTDOWN_DRAIN_MS`; the in-app timeout is `SHUTDOWN_TIMEOUT_MS` = 25 s).
- Probes (all HTTP GET on port `http`):
  - startup `/healthz/startup`, period 5 s, failure threshold 60 (tolerates waiting for the migration Job or slow dependencies without being killed)
  - liveness `/healthz/live`, period 10 s, failure threshold 3
  - readiness `/healthz/ready`, period 5 s, failure threshold 2, timeout 4 s
- Security context: `run_as_non_root`, `run_as_user = 65532`, `read_only_root_filesystem = true` (verified: the app needs no writable paths), `allow_privilege_escalation = false`, drop all capabilities, `seccomp RuntimeDefault`; `automount_service_account_token = false`.
- Optional: a `topology_spread_constraint` across nodes and a `kubernetes_pod_disruption_budget_v1` with `min_available = 1`.

**5. Service + Ingress**: ClusterIP Service port 80 → `http`; on k3s the bundled Traefik ingress works as is (`ingressClassName = "traefik"`, TLS via cert-manager or Traefik's ACME resolver); Ingress host `factory.nikorag.co.uk` with TLS, path `/` Prefix. The hub trusts `X-Forwarded-For` (it uses `trustProxy`), so terminate TLS at the ingress and don't expose the Service directly. Proxy read timeouts must exceed 25 s (factory long-polls) and allow open-ended streams (dashboard SSE), e.g. for ingress-nginx `proxy-read-timeout: 3600` and `proxy-buffering: off`.

**PostgreSQL**: create an empty database and a dedicated role that owns it (`CREATE ROLE hub LOGIN PASSWORD '…'; CREATE DATABASE hub OWNER hub;`), ideally also in Terraform via the `postgresql` provider. No extensions are required. **Redis**: any Redis ≥ 6.2 (tested on 7); set `REDIS_KEY_PREFIX` if shared. Both are reached by in-cluster DNS names in `DATABASE_URL` / `REDIS_URL`; URL-encode special characters in passwords.

**Order of operations on each release:** apply ConfigMap/Secret → migration Job completes → Deployment rolls to the new tag.

## Migrations

- Versioned SQL in `hub/migrations/NNNN_name.sql`, forward-only, applied in order, each recorded in `schema_migrations` with a checksum. Editing an applied file fails the run: add a new migration instead.
- Run by **`node dist/cli.js migrate`**, packaged as the Job above. Replicas **never** migrate at startup; they only check the schema is current. A pod started before the Job finishes stays `starting` (startup probe, up to 5 min) instead of crash-looping, and readiness stays false while migrations are pending.
- Concurrency-safe: one transaction holding `pg_advisory_xact_lock`; a double run is a no-op. Each migration is atomic (all-or-nothing).
- `node dist/cli.js migrate-status` exits 2 if any are pending.
- Rules for new migrations: additive first (new nullable columns/tables), backfill in the migration, drop/rename only in a later release once no running version uses the old shape (expand → migrate → contract). The rolling update runs old and new pods side by side, so the schema must work for both.
- Give the Job a per-version name in Terraform so each release runs a fresh one (Jobs are immutable).

## Health

| Endpoint | Meaning | Probe |
|---|---|---|
| `/healthz/live` | event loop answers. **No** dependency checks | liveness |
| `/healthz/startup` | initial Redis + schema check passed | startup |
| `/healthz/ready` | not shutting down, PostgreSQL + Redis reachable, schema current. JSON body shows each check | readiness |

A PostgreSQL/Redis outage makes pods **unready** (removed from the Service) but not restarted; they recover on their own.

## Logs

JSON lines on stdout (pino), `level` as a string, ISO timestamps. Every request carries `reqId` (honours `x-request-id`), and `factoryId` / `userId` / `commandId` where relevant. Authorization/cookie headers, tokens, secrets, passkey and push-subscription material, VAPID/DB/Redis settings, and command payloads/results are redacted. Health probes are not logged.

```bash
kubectl logs -f deploy/software-factory-hub
kubectl logs deploy/software-factory-hub | jq 'select(.commandId=="…")'
kubectl logs job/<migrate-job-name>
```

## Upgrade and roll back

1. Build and push the new version tag. 2. Change the image version variable in Terraform and apply: the new migration Job runs and must complete, then the Deployment rolls (`max_unavailable = 0`, so capacity is kept). 3. Watch `kubectl rollout status deploy/software-factory-hub`.

Roll back: set the image version variable back and apply (or `kubectl rollout undo deploy/software-factory-hub`, then reconcile Terraform). Do **not** re-run an older migration Job: migrations are forward-only and not undone, which is why every migration must stay compatible with the previous version (expand → migrate → contract). If a migration itself is bad, fix forward with a new migration or restore the database from backup.

## Shutdown behaviour

On SIGTERM the pod immediately reports unready, waits `SHUTDOWN_DRAIN_MS` for endpoint removal to propagate, then stops background loops, releases long-polls and SSE streams, finishes in-flight requests and the active queue job, and closes PostgreSQL/Redis. `terminationGracePeriodSeconds` (45) exceeds the in-app timeout (25s). Interrupted work is safe: commands are leased in PostgreSQL and recovered by `reconcile()`.

## Scope: what the hub is and is not

The hub is a **passive dashboard and ingest point** for factories running on your own machines. It does not run agents, hold Claude/Anthropic/GitHub/Linear credentials, or call any model: all Claude Code, git and tracker work stays local. It stores only the metadata a local factory chooses to report (see `docs/hub-client.md` for exactly what) and shows it behind a passkey login.

Built: passkey authentication, API keys, factory registration/rotation, event + metadata ingest, live dashboard (SSE), durable command queue.

Not built yet:
- **Acting on commands.** The hub can queue remote commands, but the local factory does not poll for or execute them, and the dashboard has no buttons for them. Today the link is one-way: factory → hub.
- Web Push sending and notification workers (the tables, VAPID settings and queue plumbing exist).
- More than one user: after the first, there is no invite flow.
- Ticket titles: the local factory doesn't store them, so jobs show the ticket key.
