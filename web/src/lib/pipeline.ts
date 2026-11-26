import { BUILTIN_HELP } from "./builtin-stages";
import { executionOrder } from "./graph";
import type { Execution, Invocation, Job } from "./types";
import { COMPLETE, type GateRecord, type RouteRecord, type StageDef, type WorkflowDef } from "./workflows";

export const HELD_STAGES = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"];
/** Where the stage's own text comes from: the workflow definition (name, description), with built-in help only as extra detail. */
export const stageNames = (def: WorkflowDef | null | undefined): Record<string, string> => Object.fromEntries((def?.stages ?? []).map((s) => [s.id, s.name]));

/**
 * A definition to draw when the API did not send one (an old server, or a job with nothing recorded): the stages seen in the job's
 * own history, in the order they first ran, plus the stage it is at now. Never a hardcoded pipeline.
 */
export function fallbackDefinition(stageOrder: string[], executions: Execution[], job: Job): WorkflowDef {
  const ids = [...new Set([...stageOrder, ...executions.map((e) => e.stage), ...(job.stage && !HELD_STAGES.includes(job.stage) ? [job.stage] : []), ...(job.heldFromStage ? [job.heldFromStage] : [])])].filter((i) => i !== COMPLETE);
  const stage = (id: string): StageDef => ({ id, name: BUILTIN_HELP[id]?.name ?? id.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), description: BUILTIN_HELP[id]?.what ?? "", type: "factory", handler: id, enabled: true, required: true, timeoutSeconds: 900, retry: { max: 0, backoff: true }, successGate: { type: "result_ok" }, onFailure: [], requires: [], outputs: [], config: {} });
  return { schemaVersion: 1, stages: ids.map(stage), limits: {} };
}

export type NodeState = "idle" | "done" | "run" | "wait" | "fail" | "blocked" | "skipped";
export interface RouteEntry { exec: Execution; route: RouteRecord }
export interface NodeFlow {
  state: NodeState; attempts: number; durationMs: number; retries: number; lastExec: Execution | null;
  /** The models that really ran for this stage (from the agent runs), in first-used order. */
  models: string[]; gate: GateRecord | null; routes: RouteEntry[]; skippedReason: string | null;
}
export interface Flow {
  nodes: Record<string, NodeFlow>;
  /** Edge ids (`from>to`) the job really took: success edges, branches and failure routes alike. */
  taken: Set<string>;
  /** Of the taken edges, the ones that sent the job back (a `goto` failure route). */
  loopsUsed: Set<string>;
  /** Fix cycles per budget phase, from the routes the engine recorded. */
  cycles: Record<string, { used: number; of: number }>;
  active: string | null; elapsedMs: number; agentMs: number; executionCount: number;
}

export const emptyNode = (): NodeFlow => ({ state: "idle", attempts: 0, durationMs: 0, retries: 0, lastExec: null, models: [], gate: null, routes: [], skippedReason: null });
const SKIPPED = /"skipped"\s*:\s*true/;
/** A succeeded execution whose output says it was skipped (a runIf that did not hold, a dry run): clipped output is not valid JSON, so look at the text. */
export const wasSkipped = (e: Execution): boolean => e.outcome === "succeeded" && !!e.output && SKIPPED.test(e.output);
const skipReason = (e: Execution): string | null => { try { const v = JSON.parse(e.output ?? "") as { reason?: unknown }; return typeof v.reason === "string" ? v.reason : null; } catch { return e.route?.reason ?? null; } };

/**
 * Derives everything the chart shows from what the factory already stores (the job's workflow snapshot, its stage executions and agent
 * runs), so counts, loops and timings are the real ones and there is no separate state to drift. `def` may be null (nothing recorded).
 */
export function deriveFlow(job: Job, def: WorkflowDef | null, executions: Execution[], invocations: Invocation[], now = Date.now()): Flow {
  const known = new Set((def?.stages ?? []).map((s) => s.id));
  const nodes: Record<string, NodeFlow> = {};
  const node = (id: string) => (nodes[id] ??= emptyNode());
  const taken = new Set<string>(), loopsUsed = new Set<string>(), cycles: Flow["cycles"] = {};
  const modelsByExec = new Map<number, string[]>();
  for (const i of invocations) if (i.stageExecutionId !== null && i.model) modelsByExec.set(i.stageExecutionId, [...(modelsByExec.get(i.stageExecutionId) ?? []), i.model]);

  const real = executions.filter((e) => e.outcome !== "waiting").sort((a, b) => a.id - b.id); // a re-check while waiting (CI, your merge) is not another attempt, and takes no time
  real.forEach((e, i) => {
    if (def && !known.has(e.stage)) return;
    const n = node(e.stage);
    n.attempts++;
    n.lastExec = e;
    if (e.finishedAt && e.startedAt) n.durationMs += e.finishedAt - e.startedAt;
    for (const m of modelsByExec.get(e.id) ?? []) if (!n.models.includes(m)) n.models.push(m);
    if (e.gate) n.gate = e.gate;
    if (e.route) {
      n.routes.push({ exec: e, route: e.route });
      if (e.route.action === "retry") n.retries++;
      if (e.route.action === "goto" && e.route.to) { taken.add(`${e.stage}>${e.route.to}`); loopsUsed.add(`${e.stage}>${e.route.to}`); if (e.route.phase) cycles[e.route.phase] = { used: Math.max(cycles[e.route.phase]?.used ?? 0, e.route.cycle ?? 0), of: e.route.of ?? 0 }; }
      if ((e.route.action === "branch" || e.route.action === "next") && e.route.to) taken.add(`${e.stage}>${e.route.to}`);
    }
    // The job moved from this execution to the next one: a success edge was taken, whichever stage it reached.
    const nextExec = real[i + 1];
    if (e.outcome === "succeeded" && nextExec && nextExec.stage !== e.stage && !e.route?.to) taken.add(`${e.stage}>${nextExec.stage}`);
    if (e.outcome === "succeeded" && !nextExec && job.stage === COMPLETE && !e.route?.to) taken.add(`${e.stage}>${COMPLETE}`);
    if (e.route?.action === "skip" && nextExec) taken.add(`${e.stage}>${nextExec.stage}`);
    n.state = e.route?.action === "goto" ? "done" // it did its work and sent the job back
      : wasSkipped(e) ? "skipped"
      : e.outcome === "succeeded" ? "done"
      : e.outcome === "started" ? (job.status === "running" ? "run" : "wait")
      : e.route?.action === "skip" ? "skipped"
      : "fail"; // failed, timed_out, cancelled
    n.skippedReason = n.state === "skipped" ? skipReason(e) : null;
  });

  const held = HELD_STAGES.includes(job.stage);
  const at = held ? job.heldFromStage : job.stage;
  const active = at && at !== COMPLETE && (!def || known.has(at)) ? at : null;
  if (active) {
    const n = node(active);
    n.state = held ? (job.stage === "PAUSED" ? "wait" : job.stage === "BLOCKED" || job.stage === "NEEDS_ATTENTION" ? "blocked" : "fail") : job.status === "running" ? "run" : "wait";
  }
  if (job.stage === COMPLETE) node(COMPLETE).state = "done";
  const first = executions.find((e) => e.startedAt)?.startedAt ?? job.createdAt ?? now;
  const end = job.status === "done" || job.status === "failed" || job.status === "cancelled" ? (job.updatedAt ?? now) : now;
  return { nodes, taken, loopsUsed, cycles, active, elapsedMs: Math.max(0, end - first), agentMs: invocations.reduce((s, i) => s + (i.durationMs ?? 0), 0), executionCount: real.length };
}

export const nodeState = (f: Flow, id: string): NodeState => f.nodes[id]?.state ?? "idle";

/** One square per step on the success path, for list rows: states from where the job is now, in the order the workflow runs. */
export function stripOrder(def: WorkflowDef | null | undefined): string[] { return def ? [...executionOrder(def).main] : []; }
export function stripStates(job: Job, order: string[]): NodeState[] {
  const held = HELD_STAGES.includes(job.stage);
  const at = held ? job.heldFromStage : job.stage;
  if (job.stage === COMPLETE || job.status === "done") return order.map(() => "done");
  const cur = at ? order.indexOf(at) : -1;
  return order.map((_, i) => (cur < 0 ? "idle" : i < cur ? "done" : i > cur ? "idle" : held ? (job.stage === "PAUSED" ? "wait" : job.stage === "FAILED" || job.stage === "CANCELLED" ? "fail" : "blocked") : job.status === "running" ? "run" : "wait"));
}

/** A sentence per failure rule, plus what happens when none matches (the engine's own defaults). */
export function describeFailures(s: StageDef, names: Record<string, string>): string[] {
  const nm = (id: string) => names[id] ?? id;
  const out = s.onFailure.map((r) => {
    const on = r.on === "any" ? "Any failure" : r.on === "findings" ? "Findings to fix" : r.on === "gate" ? "The success gate not passing" : r.on === "timeout" ? "A timeout" : "An error";
    const what = r.action === "retry" ? `retry (up to ${s.retry.max} time${s.retry.max === 1 ? "" : "s"})` : r.action === "goto" ? `send the job to “${nm(r.target ?? "")}”${r.maxCycles ? ` (at most ${r.maxCycles} fix cycles)` : ""}` : r.action === "skip" ? "skip this step" : r.action === "block" ? "block the job until a person answers" : r.action === "manual" ? "ask a person (needs attention)" : "fail the job";
    return `${on}: ${what}.`;
  });
  return out;
}
