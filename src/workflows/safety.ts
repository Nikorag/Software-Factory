import { MUTATING } from "../core/workflow.js";

/**
 * Safety gates the system enforces no matter what a workflow says. They are code, not configuration: a workflow can order its stages and
 * tune them, but it cannot remove, disable, skip, route around or weaken any of these. Validation rejects a workflow that tries, and the engine
 * independently refuses to run a guarded stage whose guards have not passed in the job (see Engine.safetyBlock).
 */
export interface MandatoryGate {
  /** The factory stage that must be present, enabled, required and unconditional. */
  handler: string;
  /** Stages that must not be reachable except through it: `mutating` means every stage with side effects. */
  guards: "mutating" | string[];
  why: string;
}

export const MANDATORY_GATES: readonly MandatoryGate[] = [
  { handler: "ELIGIBILITY_CHECK", guards: "mutating", why: "re-checks against the live ticket that a person still wants the factory to act, before anything changes a repository, the tracker or the host" },
  { handler: "LOCAL_MODEL_REVIEW", guards: ["PULL_REQUEST_CREATION"], why: "the independent review and the security review of the change; a critical finding stops the job for a person" },
  { handler: "FINAL_VALIDATION", guards: ["PULL_REQUEST_CREATION"], why: "the checks no reviewer can waive: tests re-run, no skipped tests, no secrets in history, every requirement evidenced" },
];

/** Factory stages whose agents write to the worktree: they need file and shell tools, so a stage model must stay on Claude Code (never `local`). */
export const TOOL_HANDLERS: ReadonlySet<string> = new Set(["SPECIFICATION_GENERATION", "SPECIFICATION_REMEDIATION", "IMPLEMENTATION", "REMEDIATION"]);

/** The stages that change the code under review: a guard that passed before one of these ran no longer covers the new code. */
export const CODE_CHANGERS: ReadonlySet<string> = new Set(["IMPLEMENTATION", "REMEDIATION"]);

export const isMutatingHandler = (h: string): boolean => MUTATING.has(h as never);
