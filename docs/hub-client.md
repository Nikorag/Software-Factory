# Hub client: report your factory's progress to a central hub

Your local factory can report how it is getting on to a Software Factory Hub (for example `https://factory.nikorag.co.uk`), so you can check in from a browser. It is **off by default**. Nothing leaves your machine until you connect.

## Turn it on
1. Open the hub in your browser and sign in with your passkey (accounts use passkeys only).
2. Register this factory there. The hub shows an **API key** (it looks like `sfh_…`) **once**: copy it.
3. On this machine:
   ```bash
   software-factory hub connect --url https://factory.nikorag.co.uk
   ```
   Paste the key when asked (it is not echoed). You can instead pipe it (`pbpaste | software-factory hub connect --url …`) or set `FACTORY_HUB_KEY`. Avoid `--key`, which leaves the key in your shell history.
4. The command checks the key with the hub first. Only if the hub accepts it is the key stored (macOS keychain; or `FACTORY_HUB_KEY` in the service's environment) and reporting switched on. A running factory picks this up within a minute: no restart needed.

Each profile connects separately (`software-factory --profile work hub connect …`), with its own key.

`software-factory hub status` shows whether reporting is on, the hub, whether a key is present, the last success and the last error. It never prints the key.

## Turn it off
```bash
software-factory hub disconnect
```
Reporting stops and the key is deleted from this machine. Revoke the key on the hub too if it should stop working everywhere.

## What is sent
Metadata only, from a fixed list of fields:
- the factory version, whether it is paused or stopped, the tracker name, job counts by status;
- project ids; jobs: id, ticket key (e.g. `ENG-123`), stage, status, the workflow name, attempt counts, PR URL, created/updated times;
- stage events: stage name, attempt, outcome, start/finish times, duration;
- decision events: kind, actor, and a short decision string.

## What is never sent
Repository contents, diffs, agent conversations or logs, ticket text, error messages, decision rationales, file paths, environment variables, or any secret or token. Tests assert this.

## Behaviour
- Reporting runs every 30 seconds (`factory.hub.reportIntervalSeconds`) inside the service and can never block or crash the factory. If the hub is down it retries with exponential backoff (30 s up to 15 min); nothing is lost, because progress is read from the local database.
- Events have stable ids and a saved cursor (`<dataDir>/hub-state.json`), so restarts resume where they left off and resends are harmless.
- If the hub answers 401/403 the key is considered revoked: reporting stops and `hub status` says so until you run `hub connect` with a new key.
- Only `https://` hubs are accepted (plain `http://` only for `localhost`).


## Remote dashboard (optional, off by default)

Reporting only *shows* your factory on the hub. **Remote access** goes further: the hub's web dashboard is the same dashboard you use locally, and with this on, signed-in users of your hub can operate this factory from it (pause it, answer a held job, retry, edit workflows, read agent logs...). Every dashboard request is relayed by the hub to this machine, which runs it against its own local API and sends the answer back.

It is a **separate switch** from reporting. Connecting never turns it on:
```bash
software-factory hub connect --url https://factory.nikorag.co.uk --remote-access   # connect AND enable
software-factory hub remote-access on      # enable later
software-factory hub remote-access off     # disable (a running factory stops within seconds)
software-factory hub status                # shows "remote UI: on/off"
```
Rules: it only turns on while a hub is connected; reconnecting (even to the same hub) resets it to off unless you pass `--remote-access` again, so a different hub can never inherit an earlier grant; `hub disconnect` turns it off. The hub also shows "remote access disabled on this factory" (the heartbeat carries the setting) instead of failing requests.

How it works: the factory long-polls the hub (outbound only, the same key as reporting; no inbound port is opened), runs each relayed request in-process against the dashboard's own API with the dashboard's local trust headers, and posts the response back. A request is dropped if the hub's deadline for it has passed. Bodies over 1 MB in, or 5 MB out, are refused.

### What is blocked remotely, and why
The rules live in one file, `src/hub/remote-policy.ts`, **default-deny**: a route that is not listed is refused. A test enumerates every route the server registers and fails if one is unclassified, so a new feature is never remotely reachable by accident. Only paths under `/api/` are ever relayed; the local dashboard's own files are served by the hub itself.

| Blocked remotely | Why |
|---|---|
| `POST /api/setup/linear-key`; Bitbucket credentials (`PUT`/`DELETE /api/bitbucket/credentials/:name`, `POST …/test`); Jira app/connect/disconnect/site (`PUT /api/jira/app`, `POST /api/jira/connect\|disconnect\|site`), `GET /api/jira/oauth/callback` | Credentials. Set them on the machine itself. (Read-only status views, which only say whether a token is set, are allowed.) |
| `POST /api/control/shutdown` | Stops the factory process: you could not start it again remotely. (Pause, resume, emergency stop and clear-stop *are* allowed.) |
| `POST /api/profiles`, `DELETE /api/profiles/:name` | Profiles are separate local installs. |
| `PUT /api/settings/projects/:id`, `DELETE /api/settings/projects/:id` | **Decision needed.** A project's settings carry the repository path and the install/build/test shell commands, so editing them remotely means choosing what runs on this machine (sandboxed, but installs have network). Blocked until you decide it should be allowed. |
| `GET /`, `/assets/*`, `/health` | Local-only; the hub serves its own copy of the dashboard. |

The job page's **Ask Claude** chat works remotely too. It starts a read-only agent on your machine (it can read the job's stages, decisions and recent agent output, and cannot change anything) and the page polls for the answer, so it works through the hub's short request limit.

Everything else the dashboard does is allowed: reading jobs, logs, conversations, the board and settings; pause/resume/stop; answering, retrying, cancelling, archiving and deleting jobs; starting tickets from the board; global settings; tracker connections (add, rename, remove; their credentials are not allowed remotely) and the GitHub Issues/Jira mappings; project actions (clone, validate, run checks, onboarding); tracker setup; the version check (it only looks, it never updates).

### What passes through the hub
Requests and responses pass through the hub's memory and short-lived Redis keys (seconds, with an expiry) and are **not stored in PostgreSQL**. That includes job lists, ticket keys, **agent conversations and logs** (which can hold ticket text and code), so whoever operates the hub can see them while they are in transit. Only turn this on for a hub you run and trust. The factory itself never logs request or response bodies or headers; at debug level it logs only the method, route pattern, status and duration.

### Audit
Every *changing* remote request (anything that is not a read) is recorded in this factory's decisions log as `actor: hub-remote` with the method, route pattern and status, e.g. `POST /api/jobs/:id/cancel -> 200`: no ids, no query, no body. They are reported to the hub as decision events like any other, and also written to the factory log at info.
