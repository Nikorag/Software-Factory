import { STAGES, type StageName } from "../config/schema.js";

export type JobStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";

/** Happy-path successor for each stage. Overrides skip remediation stages when nothing needs fixing. */
export const HAPPY_NEXT: Partial<Record<StageName, StageName>> = (() => {
  const m: Partial<Record<StageName, StageName>> = {};
  STAGES.forEach((s, i) => { const n = STAGES[i + 1]; if (n) m[s] = n; });
  m.SPECIFICATION_REVIEW = "SPECIFICATION_VALIDATION"; // clean review: no remediation needed
  m.CLAUDE_REVIEW = "FINAL_VALIDATION";
  m.REMEDIATION = "AUTOMATED_TESTING"; // re-verify everything after a fix
  return m;
})();

/** Where a stage sends the job when it reports findings that need fixing. Absent = stage cannot remediate. */
export const REMEDIATE_TO: Partial<Record<StageName, StageName>> = {
  SPECIFICATION_REVIEW: "SPECIFICATION_REMEDIATION",
  SPECIFICATION_VALIDATION: "SPECIFICATION_REMEDIATION",
  AUTOMATED_TESTING: "REMEDIATION",
  LOCAL_MODEL_REVIEW: "REMEDIATION",
  CLAUDE_REVIEW: "REMEDIATION",
  FINAL_VALIDATION: "REMEDIATION",
  CI_VALIDATION: "REMEDIATION",
};

/** Stages with side effects on repositories, Linear or GitHub. Skipped (and recorded) in dry-run. */
export const MUTATING = new Set<StageName>([
  "SPECIFICATION_GENERATION", "SPECIFICATION_REMEDIATION", "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION",
  "REMEDIATION", "PULL_REQUEST_CREATION", "MERGING", "LINEAR_COMPLETION",
]);

export const nextStage = (s: StageName): StageName | undefined => HAPPY_NEXT[s];
export const remediationTarget = (s: StageName): StageName | undefined => REMEDIATE_TO[s];
export const isMutating = (s: StageName): boolean => MUTATING.has(s);

export function statusForStage(s: string): JobStatus {
  switch (s) {
    case "COMPLETED": return "done";
    case "FAILED": return "failed";
    case "CANCELLED": return "cancelled";
    case "BLOCKED": case "PAUSED": case "NEEDS_ATTENTION": return "waiting";
    default: return "queued";
  }
}
