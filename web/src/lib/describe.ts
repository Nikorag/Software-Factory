import { CONDITION_OPS, type Condition, type FailureRule, type Gate } from "./workflows";

const fieldName = (f: string) => (f.startsWith("job.") ? `the job's ${f.slice(4)}` : f.startsWith("outputs.") ? `the output of ${f.split(".")[1]}: ${f.split(".").slice(2).join(".")}` : `the stage's output ${f.slice(7)}`);
export function describeCondition(c: Condition): string {
  const op = CONDITION_OPS.find((o) => o.op === c.op);
  return `${fieldName(c.field)} ${op?.label ?? c.op}${op?.needsValue && c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`;
}

/** The one-line meaning of a gate leaf. */
export function describeLeaf(g: Gate): string {
  switch (g.type) {
    case "result_ok": return "the stage itself reported success";
    case "verdict_approved": return "the reviewer's verdict is “approve”";
    case "no_blocking_findings": return `the review has no ${g.severities?.length ? g.severities.join(" / ") : "blocking (critical, blocker, major)"} findings`;
    case "exit_code_zero": return "the command exited with code 0";
    case "tests_passed": return "the test run passed";
    case "artifact_exists": return `the file ${g.path || "…"} exists in the job's worktree`;
    case "fields_present": return `the output has ${g.fields.length ? g.fields.join(", ") : "…"}`;
    case "condition": return describeCondition(g.condition);
    case "all": case "any": return g.type === "all" ? "all of the nested conditions hold" : "any of the nested conditions holds";
  }
}

/** Plain language for "what must be true before the next stage runs". Nested gates become an indented list. */
export function describeGate(g: Gate, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (g.type === "all" || g.type === "any") {
    if (depth === 0 && g.of.length === 1) return describeGate(g.of[0]!, 0);
    const head = depth === 0 ? (g.type === "all" ? "Every one of these must be true:" : "At least one of these must be true:") : g.type === "all" ? "all of:" : "any of:";
    return [`${pad}${head}`, ...g.of.flatMap((x) => (x.type === "all" || x.type === "any" ? describeGate(x, depth + 1).map((l, i) => (i === 0 ? `${pad}- ${l.trimStart()}` : l)) : [`${pad}- ${describeLeaf(x)}`]))].slice(depth === 0 ? 0 : 0);
  }
  return [`${describeLeaf(g)}`];
}
export const gateSummary = (g: Gate): string => describeGate(g).join("\n");

/** What the engine does for a failure kind when no rule of the stage matches it. */
export const FAILURE_DEFAULTS: Record<FailureRule["on"], string> = {
  error: "retried (up to the retry limit, with backoff), then the job fails",
  timeout: "retried (up to the retry limit, with backoff), then the job fails",
  gate: "retried (up to the retry limit, with backoff), then the job fails",
  findings: "the job fails: a stage that reports findings needs a goto route to fix them",
  any: "(matches every kind above)",
};
export const FAILURE_NOTES = [
  "A critical finding always stops the job for a person: no rule can retry, skip or route around it.",
  "A goto route spends the fix-cycle budget of its phase; when the budget is used up the job asks for a person.",
  "A retry rule with no retries left falls through to the next rule.",
];

import type { WorkflowUsage } from "./workflows";
const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
/** Where a workflow is used, in a few words: projects, labels, active jobs, the global default. */
export function usageParts(u: WorkflowUsage): string[] {
  return [...(u.isGlobalDefault ? ["global default"] : []), ...(u.projects.length ? [n(u.projects.length, "project")] : []), ...(u.labels.length ? [n(u.labels.length, "label")] : []), ...(u.activeJobs ? [n(u.activeJobs, "active job")] : [])];
}
export const hasAssignments = (u: WorkflowUsage) => u.projects.length + u.labels.length > 0;
