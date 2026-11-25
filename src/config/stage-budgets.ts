import type { StageName } from "./schema.js";

/**
 * The least time each stage needs to finish its own work, in seconds, built from what its handler is allowed to spend:
 * agent timeouts (see src/speckit/handlers.ts and src/implement/handlers.ts), project commands (each bounded by
 * `commandTimeoutSeconds`) and a margin for git, diffs, secret scans and process shutdown.
 *
 * A stage timeout below this would abort work the handler is still entitled to do, discard it and run the stage again
 * from scratch, so the engine never uses a timeout smaller than this, whatever workflows.yaml says and for every
 * workflow (feature, bugfix, maintenance...). Stages not listed here do only short work and use the configured timeout.
 *
 * Keep in step with the handlers' own timeouts when they change.
 */
export interface BudgetInputs {
  commandTimeoutSeconds: number;
  /** Implement-then-converge rounds one IMPLEMENTATION stage may take (maxImplementationPasses, project override first). */
  implementationPasses: number;
}

const MIN = 60;
const MARGIN = 10 * MIN; // git, diffs, worktree preparation, secret scan, SIGTERM grace, post-run checks
const CHECKS = 4; // build, typecheck, lint, test: each its own command
const SPEC_STEPS = 4; // specify, clarify, plan, tasks

export function stageBudgetSeconds(stage: StageName, i: BudgetInputs): number | undefined {
  const cmd = i.commandTimeoutSeconds;
  switch (stage) {
    case "REQUIREMENTS_ANALYSIS": return 5 * MIN + 10 * MIN + MARGIN; // local classification + analysis
    case "SPECIFICATION_GENERATION": return SPEC_STEPS * 2 * 15 * MIN + MARGIN; // each step 15 min, rerun once if its file is missing
    case "SPECIFICATION_REVIEW": return 2 * 15 * MIN + MARGIN; // independent review, plus a fresh Claude reviewer if the local one is unavailable
    case "SPECIFICATION_VALIDATION": return 15 * MIN + MARGIN; // analyze
    case "SPECIFICATION_REMEDIATION": return 20 * MIN + MARGIN;
    case "IMPLEMENTATION_PREPARATION": return (1 + CHECKS) * cmd + MARGIN; // install + baseline checks
    case "IMPLEMENTATION": return Math.max(1, i.implementationPasses) * (55 * MIN + 15 * MIN) + MARGIN; // per pass: implement + converge
    case "AUTOMATED_TESTING": return CHECKS * cmd + CHECKS * 5 * MIN + MARGIN; // checks + a classifier per failing check
    case "LOCAL_MODEL_REVIEW": return 2 * 15 * MIN + 15 * MIN + MARGIN; // independent review (with fallback) + security review
    case "CLAUDE_REVIEW": return 20 * MIN + MARGIN;
    case "REMEDIATION": return 40 * MIN + MARGIN;
    case "FINAL_VALIDATION": return CHECKS * cmd + 25 * MIN + MARGIN; // checks + final review
    default: return undefined;
  }
}

/** The timeout the engine uses: the configured one, but never less than the stage's own budget. */
export function effectiveStageTimeoutSeconds(stage: StageName, configured: number, i: BudgetInputs): number {
  return Math.max(configured, stageBudgetSeconds(stage, i) ?? 0);
}
