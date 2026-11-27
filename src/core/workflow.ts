import { STAGES, type PlanningMode, type StageName } from "../config/schema.js";

export type JobStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";

/** Happy-path successor for each stage. Overrides skip remediation stages when nothing needs fixing. */
const NEXT: Partial<Record<StageName, StageName>> = (() => {
  const m: Partial<Record<StageName, StageName>> = {};
  STAGES.forEach((s, i) => { const n = STAGES[i + 1]; if (n) m[s] = n; });
  m.SPECIFICATION_REVIEW = "SPECIFICATION_VALIDATION"; // clean review: no remediation needed
  m.CLAUDE_REVIEW = "FINAL_VALIDATION";
  m.REMEDIATION = "AUTOMATED_TESTING"; // re-verify everything after a fix
  m.CONFLICT_RESOLUTION = "AUTOMATED_TESTING"; // a merge brings in new code: re-verify, then the normal push updates the PR
  return m;
})();

/** Where a stage sends the job when it reports findings that need fixing. Absent = stage cannot remediate. */
const REMEDIATE_TO: Partial<Record<StageName, StageName>> = {
  SPECIFICATION_REVIEW: "SPECIFICATION_REMEDIATION",
  SPECIFICATION_VALIDATION: "SPECIFICATION_REMEDIATION",
  AUTOMATED_TESTING: "REMEDIATION",
  LOCAL_MODEL_REVIEW: "REMEDIATION",
  CLAUDE_REVIEW: "REMEDIATION",
  FINAL_VALIDATION: "REMEDIATION",
  CI_VALIDATION: "REMEDIATION",
};

/** The Spec Kit stages. Skipped entirely in `haiku_prompt` mode: the job goes from requirements straight to implementation. */
const SPECKIT_ONLY = new Set<StageName>(["SPECIFICATION_GENERATION", "SPECIFICATION_REVIEW", "SPECIFICATION_REMEDIATION", "SPECIFICATION_VALIDATION"]);
export const isSpecKitStage = (s: StageName): boolean => SPECKIT_ONLY.has(s);

/** Stages with side effects on repositories, Linear or GitHub. Skipped (and recorded) in dry-run. */
const MUTATING = new Set<StageName>([
  "SPECIFICATION_GENERATION", "SPECIFICATION_REMEDIATION", "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION",
  "REMEDIATION", "CONFLICT_RESOLUTION", "PULL_REQUEST_CREATION", "MERGING", "LINEAR_COMPLETION",
]);

/** The successor of a stage under the profile's planning mode (default: Spec Kit's full stage list, as before). */
export const nextStage = (s: StageName, mode: PlanningMode = "speckit"): StageName | undefined =>
  mode === "haiku_prompt" && s === "REQUIREMENTS_ANALYSIS" ? "IMPLEMENTATION_PREPARATION" : NEXT[s];
export const remediationTarget = (s: StageName): StageName | undefined => REMEDIATE_TO[s];
export const isMutating = (s: StageName): boolean => MUTATING.has(s);
export const isRemediationStage = (s: StageName): boolean => s === "SPECIFICATION_REMEDIATION" || s === "REMEDIATION";

export function statusForStage(s: StageName): JobStatus {
  switch (s) {
    case "COMPLETED": return "done";
    case "FAILED": return "failed";
    case "CANCELLED": return "cancelled";
    case "BLOCKED": case "PAUSED": case "NEEDS_ATTENTION": case "AWAITING_CONFIRMATION": return "waiting";
    default: return "queued";
  }
}
