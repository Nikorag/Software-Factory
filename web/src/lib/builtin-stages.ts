/**
 * Optional extra help for the built-in factory stages, keyed by handler id. The names come from the workflow definition itself (a
 * stage's `name` and `description`); this only supplies the longer "what happens / what can go wrong" text and a short subtitle for
 * the built-in handlers, and is the fallback label when a job has no workflow snapshot at all (very old data).
 */
export interface BuiltinHelp { name: string; sub: string; what: string; issues: string }
const b = (name: string, sub: string, what: string, issues: string): BuiltinHelp => ({ name, sub, what, issues });

export const BUILTIN_HELP: Record<string, BuiltinHelp> = {
  DISCOVERED: b("Discovered", "Linear ticket", "The job exists because discovery accepted the Linear ticket.", "Nothing to go wrong here."),
  ELIGIBILITY_CHECK: b("Eligibility check", "re-reads the ticket", "Re-reads the live ticket: still labelled factory:enabled, not blocked, still in Ready for specification.", "If someone removed the label since discovery, the job stops (Blocked) instead of acting on stale intent."),
  REQUIREMENTS_ANALYSIS: b("Requirements", "asks if unclear", "Claude reads the ticket and the code. It asks a person only when what is wanted is unclear. Design choices are decided later and recorded.", "Unclear requirements stop the job (Blocked) with the exact questions, posted to Linear."),
  SPECIFICATION_GENERATION: b("Generate spec", "Spec Kit", "Spec Kit writes the specification, clarifications, plan and tasks. The factory commits after each step.", "A step that writes nothing is re-run once before the stage retries."),
  SPECIFICATION_REVIEW: b("Spec review", "independent", "A different, cheaper model reviews the specification independently and read-only.", "Blocking findings go to Fix spec."),
  SPECIFICATION_VALIDATION: b("Spec validation", "checks + analyze", "Deterministic checks (requirements, scenarios, tasks, no open questions), then Spec Kit analyze.", "Blocking findings go to Fix spec. Open questions for a human stop the job."),
  SPECIFICATION_REMEDIATION: b("Fix spec", "Claude", "Claude fixes the valid findings and must reject invalid ones with evidence, which is recorded.", "Goes back to Spec validation. Uses one of the fix cycles."),
  IMPLEMENTATION_PREPARATION: b("Prepare", "install, baseline", "Installs dependencies (the only step with network), then runs the project's own checks on the untouched main branch.", "Checks already failing on main stop the job: failures could not be blamed on the change."),
  IMPLEMENTATION: b("Implement", "sandboxed", "Claude implements the tasks in an isolated worktree, verifying only through the sandboxed check tool. Spec Kit converge confirms nothing was missed.", "A committed secret or a touched protected file goes straight to you."),
  AUTOMATED_TESTING: b("Run checks", "test, lint, types", "The factory runs build, typecheck, lint and tests itself, in a sandbox with no network.", "Any failure goes to Fix findings with the log (condensed by a small model if it is long)."),
  LOCAL_MODEL_REVIEW: b("Independent review", "reviewer + security", "An independent reviewer checks the diff against the spec. Security-sensitive changes also get a Claude security review.", "Blocking findings go to Fix findings. A critical security finding goes straight to you."),
  CLAUDE_REVIEW: b("Claude review", "Claude", "Claude reviews the change and gives a verdict, with evidence, on each of the independent reviewer's findings.", "Blocking findings go to Fix findings."),
  REMEDIATION: b("Fix findings", "same session", "The same Claude session resumes with the findings, fixes the valid ones and rejects the rest with reasons. Then the flow re-enters at Run checks.", "After the fix-cycle limit the job stops for you (Needs attention)."),
  FINAL_VALIDATION: b("Final validation", "gates, criteria", "Gates no reviewer can waive: all checks re-run, no skipped or deleted tests, no secrets in history, tasks ticked. Then every requirement must be shown in code and in a test.", "Anything unmet goes to Fix findings."),
  PULL_REQUEST_CREATION: b("Open PR", "push + evidence", "Pushes the branch (never forced) and opens the pull request with the evidence report as its body. Linked in Linear.", "Someone else pushed to the branch, or a PR was closed: stops for you."),
  CI_VALIDATION: b("CI", "host checks", "Waits for your host's checks. Pending is just waiting and uses no retries.", "A failing check goes to Fix findings with its log. A failing external check (for example Vercel) is reported to you, not looped on."),
  MERGE_VALIDATION: b("Merge readiness", "mergeable?", "Reports mergeability, review state and branch protection to Linear.", "Merge conflicts stop the job: the factory never rewrites history."),
  MERGING: b("Awaiting your merge", "you merge it", "The factory does not merge. It checks every 10 minutes until you merge or close the PR.", "Closed without merging: the job fails with that reason. After 14 days it asks for attention."),
  LINEAR_COMPLETION: b("Complete", "Linear → Done", "Comments in Linear, removes the finished worktree, and the issue moves to Done.", "Nothing further."),
};
