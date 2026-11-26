export type TaskId = "classification" | "specification" | "implementation" | "independent_review" | "final_review" | "prompt_generation";
export interface RouteCfg { provider: "anthropic" | "local"; model: string }
export type Routes = Record<Exclude<TaskId, "prompt_generation">, RouteCfg> & { prompt_generation?: RouteCfg };
/** The route a profile has when it never set one: Haiku writes the implementer's prompt. */
export const DEFAULT_PROMPT_ROUTE: RouteCfg = { provider: "anthropic", model: "haiku" };
export type PickupMode = "automatic" | "manual";
export type PlanningMode = "haiku_prompt" | "speckit";
export interface GlobalSettings { planningMode?: PlanningMode; maxImplementationPasses?: number; pickupMode?: PickupMode; githubAccount?: string; maxConcurrentJobs: number; maxRemediationAttempts: number; routes: Routes }

/** The model choices the factory makes, and the workflow steps each one drives (as drawn on the job's flow chart). */
export const TASKS: { id: TaskId; label: string; steps: string; local: boolean }[] = [
  { id: "classification", label: "Triage", steps: "Ticket triage before analysis; condensing long check logs", local: true },
  { id: "prompt_generation", label: "Prompt writer", steps: "Haiku-prompt mode: reads the repository and writes the implementer's prompt (Requirements)", local: false },
  { id: "specification", label: "Specification", steps: "Spec Kit mode: Requirements, Generate spec, Spec validation, Fix spec, implementation convergence checks", local: false },
  { id: "implementation", label: "Implementation", steps: "Implement, and Fix findings after a review or failed check", local: false },
  { id: "independent_review", label: "Independent review", steps: "Spec review and the independent code review (should differ from the model that wrote the work)", local: true },
  { id: "final_review", label: "Claude review", steps: "Security review, Claude review, Final validation", local: true },
];
export const PRESETS = ["default", "haiku", "sonnet", "opus"] as const;
