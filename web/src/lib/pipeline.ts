import type { Execution, Invocation, Job } from "./types";

/** The real 20-stage pipeline laid out in three bands. Labels are friendly; `stage` is the engine's id. Taken from the approved flow mockup. */
export const W = 148, H = 52;
const X = (i: number) => 24 + i * 192;
const BY = [72, 312, 552] as const;
export interface PNode { id: string; label: string; sub: string; x: number; y: number; stage: string; fix?: boolean; what: string; issues: string }
const n = (id: string, label: string, sub: string, x: number, y: number, stage: string, what: string, issues: string, fix = false): PNode => ({ id, label, sub, x, y, stage, fix, what, issues });

export const NODES: PNode[] = [
  n("disc", "Discovered", "Linear ticket", X(0), BY[0], "DISCOVERED", "The job exists because discovery accepted the Linear ticket.", "Nothing to go wrong here."),
  n("elig", "Eligibility check", "re-reads the ticket", X(1), BY[0], "ELIGIBILITY_CHECK", "Re-reads the live ticket: still labelled factory:enabled, not blocked, still in Ready for specification.", "If someone removed the label since discovery, the job stops (Blocked) instead of acting on stale intent."),
  n("req", "Requirements", "asks if unclear", X(2), BY[0], "REQUIREMENTS_ANALYSIS", "Claude reads the ticket and the code. It asks a person only when what is wanted is unclear. Design choices are decided later and recorded.", "Unclear requirements stop the job (Blocked) with the exact questions, posted to Linear."),
  n("gen", "Generate spec", "Spec Kit", X(3), BY[0], "SPECIFICATION_GENERATION", "Spec Kit writes the specification, clarifications, plan and tasks. The factory commits after each step.", "A step that writes nothing is re-run once before the stage retries."),
  n("srev", "Spec review", "Haiku, independent", X(4), BY[0], "SPECIFICATION_REVIEW", "A different, cheaper model (Haiku) reviews the specification independently and read-only.", "Blocking findings go to Fix spec."),
  n("sval", "Spec validation", "checks + analyze", X(5), BY[0], "SPECIFICATION_VALIDATION", "Deterministic checks (requirements, scenarios, tasks, no open questions), then Spec Kit analyze.", "Blocking findings go to Fix spec. Open questions for a human stop the job."),
  n("sfix", "Fix spec", "Claude", 888, 176, "SPECIFICATION_REMEDIATION", "Claude fixes the valid findings and must reject invalid ones with evidence, which is recorded.", "Goes back to Spec validation. Uses one of the 3 fix cycles.", true),
  n("prep", "Prepare", "install, baseline", X(0), BY[1], "IMPLEMENTATION_PREPARATION", "Installs dependencies (the only step with network), then runs the project's own checks on the untouched main branch.", "Checks already failing on main stop the job: failures could not be blamed on the change."),
  n("impl", "Implement", "sandboxed", X(1), BY[1], "IMPLEMENTATION", "Claude implements the tasks in an isolated worktree, verifying only through the sandboxed check tool. Spec Kit converge confirms nothing was missed, up to 3 passes.", "A committed secret or a touched protected file goes straight to you."),
  n("test", "Run checks", "test, lint, types", X(2), BY[1], "AUTOMATED_TESTING", "The factory runs build, typecheck, lint and tests itself, in a sandbox with no network.", "Any failure goes to Fix findings with the log (condensed by Haiku if it is long)."),
  n("hrev", "Independent review", "Haiku + security", X(3), BY[1], "LOCAL_MODEL_REVIEW", "Haiku reviews the diff against the spec. Security-sensitive changes also get a Claude security review.", "Blocking findings go to Fix findings. A critical security finding goes straight to you."),
  n("crev", "Claude review", "Claude", X(4), BY[1], "CLAUDE_REVIEW", "Claude reviews the change and gives a verdict, with evidence, on each of Haiku's findings.", "Blocking findings go to Fix findings."),
  n("fval", "Final validation", "gates, criteria", X(5), BY[1], "FINAL_VALIDATION", "Gates no reviewer can waive: all checks re-run, no skipped or deleted tests, no secrets in history, tasks ticked. Then every requirement must be shown in code and in a test.", "Anything unmet goes to Fix findings."),
  n("fix", "Fix findings", "same session", 696, 416, "REMEDIATION", "The same Claude session resumes with the findings, fixes the valid ones and rejects the rest with reasons. Then the flow re-enters at Run checks.", "After 3 fix cycles in total the job stops for you (Needs attention).", true),
  n("pr", "Open PR", "push + evidence", X(0), BY[2], "PULL_REQUEST_CREATION", "Pushes the branch (never forced) and opens the pull request with the evidence report as its body. Linked in Linear.", "Someone else pushed to the branch, or a PR was closed: stops for you."),
  n("ci", "CI", "GitHub Actions", X(1), BY[2], "CI_VALIDATION", "Waits for your GitHub checks. Pending is just waiting and uses no retries.", "A failing GitHub Actions check goes to Fix findings with its log. A failing external check (for example Vercel) is reported to you, not looped on."),
  n("mr", "Merge readiness", "mergeable?", X(2), BY[2], "MERGE_VALIDATION", "Reports mergeability, review state and branch protection to Linear.", "Merge conflicts stop the job: the factory never rewrites history."),
  n("hm", "Awaiting your merge", "you merge it", X(3), BY[2], "MERGING", "The factory does not merge. It checks every 10 minutes until you merge or close the PR.", "Closed without merging: the job fails with that reason. After 14 days it asks for attention."),
  n("conf", "Resolve conflicts", "merge target in", 24, 440, "CONFLICT_RESOLUTION", "If the PR conflicts with its target branch, the target is merged into the branch and Claude resolves the conflicts, keeping the intended behaviour of both sides. Then everything is re-verified and the PR is updated (never force-pushed).", "A genuine ambiguity, a protected file, or too many attempts asks you, with the specific question.", true),
  n("done", "Complete", "Linear → Done", X(4), BY[2], "LINEAR_COMPLETION", "Comments in Linear, removes the finished worktree, and the issue moves to Done.", "Nothing further."),
];
/** The profile's planning mode. `haiku_prompt` has no specification phase, so its chart has no Spec Kit steps at all. */
export type PlanningMode = "haiku_prompt" | "speckit";
export const SPEC_IDS = new Set(["gen", "srev", "sval", "sfix"]);
/** What differs in the haiku_prompt flow: one prompt-writing step instead of Spec Kit, and review and gates measure against its acceptance criteria. */
const HAIKU: Record<string, Partial<PNode>> = {
  req: { label: "Write prompt", sub: "Haiku reads the repo", what: "Claude Haiku reads the ticket, the code, the conventions and the docs, and writes one concise prompt for the implementer, with acceptance criteria. It writes the prompt only; it does not implement.", issues: "A genuinely unclear ticket stops the job (Blocked) with the exact questions, posted to the tracker." },
  impl: { what: "Claude implements from the generated prompt in an isolated worktree, verifying only through the sandboxed check tool. One run: checks, reviews and fix cycles follow.", issues: "A committed secret or a touched protected file goes straight to you." },
  hrev: { what: "Haiku reviews the diff against the generated prompt. Security-sensitive changes also get a Claude security review.", issues: "Blocking findings go to Fix findings. A critical security finding goes straight to you." },
  fval: { what: "Gates no reviewer can waive: all checks re-run, no skipped or deleted tests, no secrets in history. Then every acceptance criterion must be shown in code and in a test.", issues: "Anything unmet goes to Fix findings." },
};
/** The chart for a planning mode: the nodes that exist in it, with that mode's wording. */
export const nodesFor = (mode: PlanningMode): PNode[] => (mode === "speckit" ? NODES : NODES.filter((x) => !SPEC_IDS.has(x.id)).map((x) => ({ ...x, ...HAIKU[x.id] })));
export const NODE = Object.fromEntries(NODES.map((x) => [x.id, x])) as Record<string, PNode>;
const BY_STAGE = Object.fromEntries(NODES.map((x) => [x.stage, x.id])) as Record<string, string>;
export const nodeOfStage = (stage: string): PNode | undefined => NODE[BY_STAGE[stage] ?? ""];

export interface PEdge { id: string; from: string; to: string; kind: "flow" | "loop"; d: string; label?: { t: string; x: number; y: number; a: "start" | "middle" | "end" } }
const line = (a: string, b: string) => `M${NODE[a]!.x + W},${NODE[a]!.y + H / 2} H${NODE[b]!.x}`;
const flow = (a: string, b: string): PEdge => ({ id: `${a}>${b}`, from: a, to: b, kind: "flow", d: line(a, b) });
const loop = (from: string, to: string, d: string, label?: PEdge["label"]): PEdge => ({ id: `${from}>${to}`, from, to, kind: "loop", d, label });
export const EDGES: PEdge[] = [
  ...([["disc", "elig"], ["elig", "req"], ["req", "gen"], ["gen", "srev"], ["srev", "sval"], ["prep", "impl"], ["impl", "test"], ["test", "hrev"], ["hrev", "crev"], ["crev", "fval"], ["pr", "ci"], ["ci", "mr"], ["mr", "hm"], ["hm", "done"]] as const).map(([a, b]) => flow(a, b)),
  { id: "sval>prep", from: "sval", to: "prep", kind: "flow", d: "M1132,98 H1164 V262 H8 V338 H24" },
  { id: "fval>pr", from: "fval", to: "pr", kind: "flow", d: "M1132,338 H1164 V534 H8 V578 H24" },
  loop("srev", "sfix", "M866,124 V150 H920 V176", { t: "findings", x: 858, y: 144, a: "end" }),
  loop("sval", "sfix", "M1090,124 V202 H1036", { t: "findings", x: 1100, y: 168, a: "start" }),
  loop("sfix", "sval", "M1004,176 V124", { t: "fixed", x: 1012, y: 150, a: "start" }),
  loop("test", "fix", "M482,364 V442 H696", { t: "checks failed", x: 590, y: 458, a: "middle" }),
  loop("hrev", "fix", "M674,364 V390 H722 V416"),
  loop("crev", "fix", "M866,364 V390 H818 V416", { t: "review findings", x: 770, y: 384, a: "middle" }),
  loop("fval", "fix", "M1058,364 V442 H844", { t: "criterion unmet", x: 950, y: 436, a: "middle" }),
  loop("fix", "test", "M696,424 H440 V364", { t: "re-verify everything", x: 568, y: 416, a: "middle" }),
  loop("mr", "conf", "M482,552 V506 H98 V492", { t: "conflicts", x: 290, y: 498, a: "middle" }),
  loop("conf", "test", "M98,440 V390 H520 V364", { t: "re-verify", x: 250, y: 384, a: "middle" }),
  loop("ci", "fix", "M290,552 V516 H770 V468", { t: "CI failed", x: 530, y: 509, a: "middle" }),
];

const SPEC_EDGE = new Set(["req>gen", "gen>srev", "srev>sval", "sval>prep", "srev>sfix", "sval>sfix", "sfix>sval"]);
export const edgesFor = (mode: PlanningMode): PEdge[] => mode === "speckit" ? EDGES : [
  ...EDGES.filter((e) => !SPEC_EDGE.has(e.id)),
  { id: "req>prep", from: "req", to: "prep", kind: "flow", d: `M${NODE.req!.x + W},98 H${NODE.req!.x + W + 32} V262 H8 V338 H24` },
];
export const bandsFor = (mode: PlanningMode) => mode === "speckit" ? null : { understand: "Haiku writes the implementer's prompt" };

export type NodeState = "idle" | "done" | "run" | "wait" | "fail";
export interface Flow {
  state: Record<string, NodeState>; attempts: Record<string, number>; duration: Record<string, number>;
  loopsUsed: Set<string>; skipped: Set<string>; mode: PlanningMode; active: string | null; elapsedMs: number; agentMs: number;
}

/**
 * Derives the whole chart from what the factory already stores (stage executions and the job row), so loops, counts and timings
 * are the real ones and there is no separate state to drift. A fix route is "used" when a fix stage actually ran after that stage.
 */
/** A job that ran (or is in) a Spec Kit stage is drawn as Spec Kit whatever the profile says now. */
export const modeOfJob = (job: Job, executions: Execution[] = []): PlanningMode =>
  executions.some((e) => e.stage.startsWith("SPECIFICATION_")) || /^SPECIFICATION_/.test(job.stage) || /^SPECIFICATION_/.test(job.heldFromStage ?? "") ? "speckit" : job.planningMode ?? "speckit";

export function deriveFlow(job: Job, executions: Execution[], invocations: Invocation[], now = Date.now()): Flow {
  const held = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"].includes(job.stage);
  const at = held ? job.heldFromStage : job.stage;
  const state: Record<string, NodeState> = {}, attempts: Record<string, number> = {}, duration: Record<string, number> = {};
  const loopsUsed = new Set<string>(), skipped = new Set<string>();
  let prev: string | null = null;
  for (const e of executions) {
    const id = BY_STAGE[e.stage];
    if (!id) continue;
    if (e.outcome === "waiting") continue; // a re-check while waiting (CI, your merge) is not another attempt, and does not take time
    attempts[id] = (attempts[id] ?? 0) + 1;
    if (e.finishedAt && e.startedAt) duration[id] = (duration[id] ?? 0) + (e.finishedAt - e.startedAt);
    if (e.outcome === "succeeded") state[id] = "done";
    if (NODE[id]!.fix && prev) {
      if (id === "conf") { loopsUsed.add("mr>conf"); loopsUsed.add("conf>test"); } // detected at CI, merge readiness or while waiting: drawn from merge readiness
      else { loopsUsed.add(`${prev}>${id}`); if (id === "fix") loopsUsed.add("fix>test"); else loopsUsed.add("sfix>sval"); if (id === "sfix" && prev === "srev") skipped.add("srev>sval"); }
    }
    prev = id;
  }
  const activeId = at ? BY_STAGE[at] ?? null : null;
  if (activeId) {
    if (held) state[activeId] = job.stage === "PAUSED" ? "wait" : "fail";
    else if (job.status === "running") state[activeId] = "run";
    else state[activeId] = "wait";
  }
  if (job.stage === "COMPLETED") state["done"] = "done";
  const first = executions.find((e) => e.startedAt)?.startedAt ?? job.createdAt ?? now;
  const end = job.status === "done" || job.status === "failed" || job.status === "cancelled" ? (job.updatedAt ?? now) : now;
  return { state, attempts, duration, loopsUsed, skipped, mode: modeOfJob(job, executions), active: activeId, elapsedMs: Math.max(0, end - first), agentMs: invocations.reduce((s, i) => s + (i.durationMs ?? 0), 0) };
}

/** Compact per-stage progress for list rows: one square per main-line step, derived from the job's current stage alone. */
export const STRIP = ["disc", "elig", "req", "gen", "srev", "sval", "prep", "impl", "test", "hrev", "crev", "fval", "pr", "ci", "mr", "hm", "done"];
export const stripFor = (mode: PlanningMode): string[] => (mode === "speckit" ? STRIP : STRIP.filter((id) => !SPEC_IDS.has(id)));
export function stripStates(job: Job): NodeState[] {
  const strip = stripFor(modeOfJob(job));
  const held = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"].includes(job.stage);
  const at = held ? job.heldFromStage : job.stage;
  const cur = at ? strip.indexOf(BY_STAGE[at] === "conf" ? "mr" : BY_STAGE[at] ?? (at === "SPECIFICATION_REMEDIATION" ? "sval" : at === "REMEDIATION" ? "test" : "")) : -1;
  if (job.stage === "COMPLETED" || job.status === "done") return strip.map(() => "done");
  return strip.map((_, i) => (cur < 0 ? "idle" : i < cur ? "done" : i > cur ? "idle" : held ? (job.stage === "PAUSED" ? "wait" : "fail") : job.status === "running" ? "run" : "wait"));
}
