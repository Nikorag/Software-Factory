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
- project ids; jobs: id, ticket key (e.g. `ENG-123`), stage, status, workflow id/name/version, attempt counts, PR URL, created/updated times;
- stage events: stage name, attempt, outcome, start/finish times, duration, whether the gate passed, and where the workflow routed next;
- decision events: kind, actor, and a short decision string.

## What is never sent
Repository contents, diffs, agent conversations or logs, ticket text, error messages, decision rationales, file paths, environment variables, workflow prompts, or any secret or token. Tests assert this.

## Behaviour
- Reporting runs every 30 seconds (`factory.hub.reportIntervalSeconds`) inside the service and can never block or crash the factory. If the hub is down it retries with exponential backoff (30 s up to 15 min); nothing is lost, because progress is read from the local database.
- Events have stable ids and a saved cursor (`<dataDir>/hub-state.json`), so restarts resume where they left off and resends are harmless.
- If the hub answers 401/403 the key is considered revoked: reporting stops and `hub status` says so until you run `hub connect` with a new key.
- Only `https://` hubs are accepted (plain `http://` only for `localhost`).
