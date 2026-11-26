import { stageText } from "./format";
import { nodeOfStage } from "./pipeline";
import type { Decision, Execution, Invocation, JobDetail } from "./types";

export type Tone = "ok" | "fail" | "run" | "wait" | "loop" | "info";
export interface TimelineEvent { at: number; label: string; text: string }
export interface TimelineEntry {
  key: string; at: number; end: number | null; tone: Tone; title: string;
  /** 1 for the first time this step ran, 2 for the re-run after a fix, ... */
  run: number;
  /** which fix cycle this entry is (fix steps only) */
  cycle?: number;
  stage?: string; nodeId?: string;
  summary?: string; detail?: string;
  /** A step that was waiting (CI, your merge) is polled again and again; those polls are one entry. How many checks it covers, and when the last one was. */
  checks?: number; lastCheckAt?: number | null;
  events: TimelineEvent[]; runs: Invocation[];
}

const FIX_STAGES = new Set(["REMEDIATION", "SPECIFICATION_REMEDIATION"]);
const HELD = new Set(["BLOCKED", "FAILED", "NEEDS_ATTENTION", "PAUSED", "CANCELLED"]);
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** What a human wants to know about a decision, in a few words. Unknown kinds show as they are. */
const EVENT_LABEL: Record<string, string> = {
  "discovery.accept": "Picked up", "manual.start": "Started from the Board", "job.retry": "You retried", "job.cancel": "Cancel requested", "human.answer": "You answered",
  remediation: "Sent back", "review.result": "Review", "review.degraded": "Reviewer fallback", "agent.violation": "Boundary violation", recovery: "Recovered after a restart",
  "dry-run": "Dry run", eligibility: "Eligibility", "worktree.create": "Workspace", "code-review.independent": "Independent review", "code-review.verdict": "Claude's verdict",
  "security-review": "Security review", baseline: "Baseline checks", "implementation.pass": "Implementation pass", "pr.merged": "Merged", "ci.none": "CI", "ci.external-failing": "External CI failing",
};
const eventLabel = (kind: string) => EVENT_LABEL[kind] ?? (kind.startsWith("hold.") ? `Stopped (${kind.slice(5).toLowerCase().replace("_", " ")})` : kind);

function parse(output: string | null): Record<string, unknown> | null {
  if (!output) return null;
  try { const v = JSON.parse(output); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; } // clipped output is not valid JSON: say nothing rather than guess
}

/** A few words about what a successful step produced, from whatever its output recorded. */
export function summarise(output: Record<string, unknown> | null): string | undefined {
  if (!output) return undefined;
  const parts: string[] = [];
  const num = (k: string) => (typeof output[k] === "number" ? (output[k] as number) : undefined);
  const arr = (k: string) => (Array.isArray(output[k]) ? (output[k] as unknown[]) : undefined);
  if (num("passes")) { const n = num("passes")!; parts.push(`${n} implementation pass${n === 1 ? "" : "es"}`); }
  if (num("files") !== undefined) parts.push(plural(num("files")!, "file") + " changed");
  const acc = arr("accepted"), rej = arr("rejected");
  if (acc || rej) parts.push(`fixed ${acc?.length ?? 0}${rej?.length ? `, rejected ${rej.length} with reasons` : ""}`);
  const findings = arr("findings");
  if (findings) parts.push(findings.length ? plural(findings.length, "finding") : "no findings");
  if (typeof output.workflow === "string") parts.push(`${output.workflow} workflow`);
  if (typeof output.url === "string") parts.push(output.url);
  if (output.merged === true) parts.push("merged by a person");
  if (typeof output.summary === "string" && output.summary) parts.push(clip(output.summary, 140));
  else if (typeof output.note === "string" && output.note) parts.push(clip(output.note, 140));
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * The story of a job, oldest first, built from what the factory already records: every step attempt (with how it ended and why), the decisions
 * it made along the way (sent back for fixes, reviews, your answers), and the agent runs behind each step. Nothing here is invented.
 */
/**
 * One decision as a line of text. A human answer is stored as "answered while held at <stage>\n\n<questions>" with the answer as the
 * rationale: show only the first line plus the answer, so a long list of questions cannot push the answer out (old rows are one line).
 */
export function decisionText(x: Pick<Decision, "kind" | "decision" | "rationale">): string {
  const decision = x.kind === "human.answer" ? (x.decision ?? "").split("\n")[0]!.trim() : x.decision;
  return stageText(clip([decision, x.rationale].filter(Boolean).join(" — "), 260));
}

export function buildTimeline(d: JobDetail, cap = 3): TimelineEntry[] {
  const seen = new Map<string, number>();
  // A retry resets the fix budget, so cycles are counted since the last time a person retried the job.
  const retries = d.decisions.filter((x) => x.kind === "job.retry").map((x) => x.at ?? 0).sort((a, b) => a - b);
  let cycle = 0, lastReset = -1;
  const entries: TimelineEntry[] = [];
  // A step that is waiting (for CI, for your merge) is re-checked every few minutes and each check is its own execution. They are one
  // event in the story: group a step's consecutive waiting checks together with the execution that finally ends the wait.
  const groups: Execution[][] = [];
  for (const e of [...d.executions].sort((a, b) => a.id - b.id)) {
    const g = groups.at(-1);
    if (g && g[0]!.stage === e.stage && g.every((x) => x.outcome === "waiting")) g.push(e); else groups.push([e]);
  }
  for (const group of groups) {
    const e = group.at(-1)!;
    const waits = group.filter((x) => x.outcome === "waiting").length;
    const node = nodeOfStage(e.stage);
    const run = (seen.get(e.stage) ?? 0) + 1;
    seen.set(e.stage, run);
    const out = parse(e.output) ?? undefined;
    const remediate = out && typeof out.remediate === "string" ? (out.remediate as string) : undefined;
    const fix = FIX_STAGES.has(e.stage);
    const resets = retries.filter((r) => r <= (e.startedAt ?? 0)).length;
    if (resets !== lastReset) { lastReset = resets; cycle = 0; }
    if (fix && e.outcome === "succeeded") cycle++;
    let tone: Tone = "ok", summary: string | undefined;
    switch (e.outcome) {
      case "started": tone = "run"; summary = "running now"; break;
      case "waiting": { tone = "wait"; const why = out && typeof out.reason === "string" ? clip(out.reason, 160) : "waiting"; summary = `${why} · checked ${plural(waits, "time")}`; break; }
      case "failed": tone = "fail"; summary = e.error ? clip(e.error.split("\n")[0]!, 240) : "failed"; break;
      case "timed_out": tone = "fail"; summary = `timed out${e.error ? `: ${clip(e.error, 160)}` : ""}`; break;
      case "cancelled": tone = "info"; summary = e.error ? clip(e.error, 160) : "cancelled"; break;
      default:
        if (remediate) { tone = "loop"; summary = `Sent back for fixes: ${clip(remediate, 220)}`; } else summary = summarise(out ?? null);
    }
    if (waits && e.outcome !== "waiting") summary = summary ? `${summary} (after waiting, ${plural(waits, "check")})` : `after waiting, ${plural(waits, "check")}`;
    entries.push({
      key: `e${e.id}`, at: group[0]!.startedAt ?? 0, end: e.finishedAt, tone, run, stage: e.stage, nodeId: node?.id,
      ...(e.outcome === "waiting" ? { checks: waits, lastCheckAt: e.finishedAt ?? e.startedAt } : {}),
      title: fix ? `${node?.label ?? e.stage}${cycle ? ` · cycle ${cycle} of ${cap}` : ""}` : (node?.label ?? e.stage),
      cycle: fix && cycle ? cycle : undefined, summary: stageText(summary), detail: e.error && e.outcome !== "failed" ? e.error : undefined,
      events: [], runs: d.invocations.filter((i) => group.some((x) => x.id === i.stageExecutionId)),
    });
  }
  // decisions belong to the step that was running when they were made; the rest stand on their own
  const attach = (x: Decision): boolean => {
    const at = x.at ?? 0;
    const home = [...entries].reverse().find((en) => at >= en.at - 1000 && at <= (en.end ?? Number.MAX_SAFE_INTEGER) + 3000);
    if (!home) return false;
    home.events.push({ at, label: eventLabel(x.kind), text: decisionText(x) });
    return true;
  };
  for (const x of [...d.decisions].sort((a, b) => a.id - b.id)) {
    if (x.kind === "worktree.create") continue; // plumbing, not a story
    if (!attach(x)) entries.push({ key: `d${x.id}`, at: x.at ?? 0, end: null, tone: "info", title: eventLabel(x.kind), run: 1, summary: decisionText(x), events: [], runs: [] });
  }
  // a held job's current state is the most recent thing that happened
  if (HELD.has(d.job.stage)) {
    entries.push({ key: "held", at: d.job.updatedAt ?? Date.now(), end: null, tone: d.job.stage === "FAILED" ? "fail" : "wait", run: 1, events: [], runs: [],
      title: d.job.stage === "NEEDS_ATTENTION" ? "Needs your attention" : d.job.stage === "BLOCKED" ? "Waiting for you" : d.job.stage === "PAUSED" ? "Paused" : d.job.stage === "CANCELLED" ? "Cancelled" : "Failed",
      summary: d.job.lastError ? stageText(clip(d.job.lastError.split("\n")[0]!, 260)) : undefined, stage: d.job.heldFromStage ?? undefined, nodeId: d.job.heldFromStage ? nodeOfStage(d.job.heldFromStage)?.id : undefined });
  }
  return entries.sort((a, b) => a.at - b.at);
}

export interface TimelineStats { steps: number; fixCycles: number; problems: number; agentMs: number; runs: number; firstAt: number | null }
export function statsOf(entries: TimelineEntry[]): TimelineStats {
  const steps = entries.filter((e) => e.stage && e.tone !== "info");
  return {
    steps: steps.length, fixCycles: entries.filter((e) => e.cycle).length, problems: entries.filter((e) => e.tone === "fail").length,
    agentMs: entries.reduce((s, e) => s + e.runs.reduce((t, r) => t + (r.durationMs ?? 0), 0), 0), runs: entries.reduce((s, e) => s + e.runs.length, 0), firstAt: entries[0]?.at ?? null,
  };
}
export type { Execution };
