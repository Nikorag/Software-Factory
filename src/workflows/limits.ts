/**
 * System-level ceilings. They are enforced by validation when a workflow is saved AND again by the engine when a job runs, so a
 * workflow (or a hand-edited database row) can never ask for unbounded retries, loops, time or prompt size.
 */
export const SYSTEM_LIMITS = {
  maxStages: 40,
  maxRetries: 10,
  maxRetryDelaySeconds: 3600,
  maxStageTimeoutSeconds: 24 * 3600,
  maxWorkflowTimeoutSeconds: 7 * 24 * 3600,
  /** Fix cycles (failure routes that go back to a stage) one job may spend per phase. */
  maxFixCycles: 10,
  /** Stage attempts one job may start (waiting polls excluded) before it is held for a person: the loop guard of last resort. */
  maxStageExecutions: 200,
  maxPromptChars: 20_000,
  maxGateDepth: 5,
  maxGateNodes: 30,
  maxFailureRules: 10,
} as const;
