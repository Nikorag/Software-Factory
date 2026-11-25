export type TaskId = "classification" | "specification" | "implementation" | "independent_review" | "final_review";
export interface RouteCfg { provider: "anthropic" | "local"; model: string }
export type Routes = Record<TaskId, RouteCfg>;
export interface GlobalSettings { githubAccount?: string; maxConcurrentJobs: number; maxRemediationAttempts: number; routes: Routes }

/** The five model choices the factory makes, and the workflow steps each one drives (as drawn on the job's flow chart). */
export const TASKS: { id: TaskId; label: string; steps: string; local: boolean }[] = [
  { id: "classification", label: "Triage", steps: "Ticket triage before analysis; condensing long check logs", local: true },
  { id: "specification", label: "Specification", steps: "Requirements, Generate spec, Spec validation, Fix spec, implementation convergence checks", local: false },
  { id: "implementation", label: "Implementation", steps: "Implement, and Fix findings after a review or failed check", local: false },
  { id: "independent_review", label: "Independent review", steps: "Spec review and the independent code review (should differ from the model that wrote the work)", local: true },
  { id: "final_review", label: "Claude review", steps: "Security review, Claude review, Final validation", local: true },
];
export const PRESETS = ["default", "haiku", "sonnet", "opus"] as const;
