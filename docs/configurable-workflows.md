# Configurable workflows

A **workflow** is a reusable, declarative process: an ordered set of stages, each with its own prompt, model, gates, retries and failure routing. The factory's original process is built in as the **Default Workflow**; you can copy it, change the copy, build others from scratch, and say which tickets use which.

Four things are kept apart on purpose:

| Piece | What it is | Where |
|---|---|---|
| **Definition** | What should happen: stages, gates, routes (data, never code) | `src/workflows/definition.ts` |
| **Library** | Saved, versioned, reusable workflows | `workflows`, `workflow_versions` tables · `src/workflows/library.ts` |
| **Assignments** | Routing rules: project → workflow, Linear label → workflow, label priority | `workflow_assignments`, `workflow_settings` |
| **Engine** | Runs a job against its frozen snapshot | `src/core/engine.ts` |

Everything is managed in the app under **Workflows** (library and editor), **Settings → Workflow routing** (global default, label assignments, priority, conflict policy) and **Settings → Projects** (a project's workflow). The same operations are available over the API (`/api/workflows…`, `src/server/workflow-routes.ts`).

## The Default Workflow

- Created on a new installation and kept current on upgrade: it is **derived from the factory's own state machine** (`src/core/workflow.ts`) plus the per-stage timeouts and retry counts in `workflows.yaml`. Editing `workflows.yaml` still tunes it (it gets a new version; running jobs keep their snapshot).
- **Read-only, undeletable, cannot be disabled.** Duplicate it to get an editable copy (own id, version 1).
- The global fallback: used when no label or project assignment applies (you may choose a different global default; if that one becomes unavailable the built-in is used and the job says so).
- 19 factory stages, behaving exactly as before: same order, same fix routes (`SPECIFICATION_REVIEW`/`VALIDATION` → `SPECIFICATION_REMEDIATION`; testing, reviews, final validation and CI → `REMEDIATION` → `AUTOMATED_TESTING`), same retries and fix-cycle budgets.

## Definition

```yaml
stages:
  - id: ANALYSE                 # letters/digits/underscores; unique; not a held state (FAILED, BLOCKED…)
    name: Analyse
    type: agent                 # factory | agent | review | check | conditional
    required: true              # a required stage cannot be disabled, conditional or skipped
    enabled: true
    next: REVIEW                # optional; default is the next enabled stage in order (COMPLETED after the last)
    prompt: { template: "…{{ticket.title}}…" }
    model: { provider: anthropic, model: opus }     # optional; falls back to the configured route
    timeoutSeconds: 900
    retry: { max: 2, delaySeconds: 5, backoff: true }
    successGate: { type: fields_present, fields: [text] }
    onFailure:
      - { on: error, action: retry }
      - { on: findings, action: goto, target: BUILD, maxCycles: 2 }
    requires: [PLAN]            # stages whose output this one needs
    runIf: { field: outputs.PLAN.risky, op: truthy }   # optional stages only
    config: { role: requirements-analyst }              # per-type settings
limits: { maxStageExecutions: 200, timeoutSeconds: 86400 }
```

Validated by Zod and by `validateDefinition` (`src/workflows/validate.ts`), which reports every problem with a field path before anything is saved.

### Stage types

Registered in code (`src/workflows/stage-types.ts`); adding a type means adding a spec there and a handler (`typed-handlers.ts`). The engine, validator, API and editor need no other change.

| Type | Does | Settings |
|---|---|---|
| `factory` | Runs one of the built-in stages (the id **must equal** the handler name: handlers record and read their work by it). Behaviour fixed in code; you set order, limits, extra instructions, model and routing. | — |
| `agent` | Runs a **read-only** agent with your prompt; output `{role, text, model}`. | `role` (a read-only role) |
| `review` | Runs a read-only reviewer returning `{verdict, findings[]}`. Blocking findings route as `findings`; a `critical` finding always stops for a person. | `role`, `blocking` severities |
| `check` | Runs one of the project's configured commands (`install`, `build`, `typecheck`, `lint`, `test`) in the sandbox. Failure routes as `findings` with the log tail. The command text comes from the project's settings, never the workflow. | `command` |
| `conditional` | Evaluates a condition and picks `then` or `else`. Runs inside the engine; does no work. | `condition`, `then`, `else` |

There is no "run a script" stage and none can be defined by a workflow.

### Prompts

`agent`/`review` stages have a full `prompt.template` (the editor shows the default and can restore it). A `factory` stage's prompt is built in; `prompt.instructions` is **appended** to what its agents are told, with a note that it changes neither their rules nor their permissions. Prompts are stored in the definition and so are part of every job's snapshot.

Placeholders are `{{name}}` and nothing else (no logic). One pass: braces inside a value are never expanded again. Unknown or unavailable variables are rejected at save time with a suggestion.

`ticket.identifier|title|description|url|labels` · `project.id|name` · `repo.path|baseSha|branch` · `workflow.name|version` · `stage.id|name` · `spec.dir` · `job.id|key|attempt` · `answers` (human answers so far) · `findings` (blocking findings of the review/check that sent the job here) · `outputs.<STAGE_ID>[.field]` (an earlier stage's latest output).

`ticket.*`, `repo.*` and `spec.*` need the live ticket and worktree, so they are available to `agent`/`review` prompts but not to a factory stage's extra instructions. Agent prompts always end with a reminder that ticket text is untrusted data.

### Models and providers

A stage's `model` is `{provider?, model?}`, resolved **at run time by the existing model router** on top of the configured route for the task (and the project's overrides): you may change the model, and the provider only together with a model id. The actual model used is recorded on every agent invocation and shown in the job's pipeline. Rules enforced in code: a model id can never look like a flag; stages whose agents edit files or run commands (`SPECIFICATION_GENERATION`, `SPECIFICATION_REMEDIATION`, `IMPLEMENTATION`, `REMEDIATION`) must stay on Claude Code, and the runner refuses any tool-using role on the local model whatever a snapshot says.

### Success gates

Evaluated by `evaluateGate` (`src/workflows/gates.ts`) **after** the stage reports success, against what was recorded: so a gate can only make a stage stricter, never let a failed one through, and an agent's claim of completion is checked against its output. Deterministic; the full trace (which condition failed and why) is stored on the attempt (`stage_executions.gate_json`) and shown in the job.

`result_ok` (default for factory stages) · `verdict_approved` · `no_blocking_findings` · `exit_code_zero` · `tests_passed` · `artifact_exists` (a path inside the job worktree, symlinks contained) · `fields_present` · `condition` · `all` / `any` (AND / OR, up to 5 levels and 30 conditions).

Conditions (`runIf`, gates, `conditional`) read `job.remediationAttempts|stageAttempts|dryRun|autonomous|manual|kind`, `output.<path>` or `outputs.<STAGE_ID>.<path>` with `eq neq gt gte lt lte exists truthy contains`.

### Failure routing, retries and timeouts

When a stage fails, its `onFailure` rules run in order; the first that matches the kind of failure **and can still act** decides.

Kinds: `findings` (it reported problems to fix), `error` (transient failure), `timeout`, `gate` (finished but its gate did not pass), `any`.
Actions: `retry` (bounded by `retry.max`; out of retries it falls through to the next rule) · `goto <stage>` (e.g. back to implementation with the findings in `{{findings}}`; spends the fix-cycle budget) · `skip` (optional stages only) · `block` · `fail` · `manual` (waits for a person).

With no matching rule: `error`/`timeout`/`gate` retry then fail; `findings` fail. Retry delay is `delaySeconds` (default: the engine's backoff base), doubled each time when `backoff` is on, capped at one hour. `retry.max`, timeouts, and the attempt counters are persisted on the job, so a restart neither forgets nor repeats them.

**Never routable**, whatever the workflow says: a stage result of `blocked`, `needs_attention` or `fail` (a person is needed or the work is permanently wrong), and any `critical` finding.

#### Loops are bounded

- The success path (`next`, conditional branches) must be acyclic; the validator rejects loops. The only way back is a `goto` failure route.
- Every `goto` spends the fix-cycle budget in its phase (`specification`, `code`, `ci`: set per stage with `budget.phase`): at most the project's `maxRemediationAttempts`, the rule's own `maxCycles` if lower, and never more than 10. When it is spent the job goes to `NEEDS_ATTENTION`.
- A job may start at most `maxStageExecutions` (≤ 200) stage attempts since its last manual retry (waiting polls excluded) before it stops for a person; `limits.timeoutSeconds` bounds the whole job's wall-clock time.

System ceilings (`src/workflows/limits.ts`) are applied when saving **and again by the engine**, so a hand-edited row cannot exceed them: 40 stages, 10 retries, 1 h retry delay, 24 h stage timeout, 20 000-char prompts. For factory stages the engine still never uses a timeout below what the handler may legitimately spend (`src/config/stage-budgets.ts`).

## Safety boundaries

A workflow orders approved operations; it cannot grant itself capabilities.

- **Mandatory stages** (`src/workflows/safety.ts`): `ELIGIBILITY_CHECK` must precede every stage with side effects; `LOCAL_MODEL_REVIEW` (independent + security review) and `FINAL_VALIDATION` must precede `PULL_REQUEST_CREATION`. They must exist, be enabled, required, unconditional, unskippable, and **dominate** the guarded stages (the validator removes the stage from the graph and checks the guarded one is unreachable). A workflow that never opens a PR (research, documentation) may omit the reviews.
- **The engine enforces them again at run time**, independent of the workflow (`Engine.safetyBlock`): a guarded stage will not run unless its guards have passed in this job, and the reviews must have passed *after the code last changed*. A snapshot that fails validation is not run at all.
- Roles are fixed in code. Custom `agent`/`review` stages can only use read-only roles; the file-editing roles (`spec-writer`, `implementer`) exist only inside factory stages, where the boundary check, secret scan and protected-path check run.
- Unchanged and not configurable: repository isolation, sandbox, secret scanning, protected paths, the `factory/` branch namespace, no merge capability, no default-branch or force pushes, one agent per worktree, approval/intervention controls, dry-run skipping of mutating stages (taken from the engine's own table, not the definition).

## Assignment and resolution

`src/workflows/resolver.ts`. Decided when a ticket enters the factory (automatic discovery or "Start" on the Board), recorded on the job and in the `workflow.resolve` decision, shown in the job header.

1. **Labels.** Labels assigned a workflow are matched by **stable tracker label id** (names change and repeat across teams). Labels naming the same workflow count once. Different workflows: the lowest `priority` number wins. A tie between *different* workflows follows the **conflict policy** (Settings → Workflow routing): `block` (default: the ticket is not started and says why), `project` (use the project's workflow), `tiebreak` (the workflow whose id sorts first). The order Linear returns labels in never matters.
2. **Project.** The project's assigned workflow.
3. **Global default.** The Default Workflow unless you chose another.

A workflow that the rule picked but that is **missing, disabled or invalid is reported, never replaced**: the ticket is not started, the reason appears in the discovery report / Board error, and it starts on a later poll once the assignment is fixed. Labels deleted in Linear simply never match; the assignment screen flags them.

## Versions and snapshots

Every change to a definition creates a new version (`workflow_versions`, append-only). Renames and enable/disable do not. When a job is created the resolved definition is validated and **frozen onto the job** (`jobs.workflow_id`, `workflow_version`, `workflow_snapshot_json`, `workflow_resolution_json`). Editing, renaming, disabling or deleting a workflow, or changing assignments and priorities, affects future jobs only. Recovery, retries and manual retries all use the snapshot, and finished jobs still show the process they ran.

## Upgrading

Migration `0007_configurable_workflows` adds the tables and columns; nothing is rewritten. On start the factory creates the Default Workflow and gives every existing job without a snapshot a copy of the Default Workflow built from that job's own kind's policy in `workflows.yaml`, marked `legacy` (so in-flight jobs continue exactly as before). `workflows.yaml`, model routing, project settings and job state are untouched and keep working.

## Observability

Each attempt records `gate_json` (the gate's evaluation) and `route_json` (what the workflow decided: `next`, `retry` with attempt and delay, `goto` with cycle and budget, `skip`, `branch`, `block`, `manual`). The job page draws the pipeline from the job's snapshot, with state, attempts, model used, gate result, routing decisions and why the workflow was chosen.

## Limitations

- Factory stages' built-in prompts are not replaceable (extra instructions only); custom `agent`/`review` prompts are fully editable.
- Custom stages are read-only by design: they analyse, review and run approved checks, but cannot write files. Work that changes code uses the factory `IMPLEMENTATION`/`REMEDIATION` stages.
- One factory stage per handler per workflow (ids equal handler names).
- The workflow time limit counts wall-clock time including waits for a person.
