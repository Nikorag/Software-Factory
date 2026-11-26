import { z } from "zod";
import type { AgentRole } from "../agents/types.js";
import { Condition, COMPLETE, stageId, type Gate, type StageType } from "./definition.js";

/**
 * The registry of stage types. Everything a workflow may do is a type registered here, in code: its settings schema, its defaults and what
 * it needs. A workflow only chooses and arranges them. (The code that runs each type is in typed-handlers.ts, and `factory` stages run the
 * existing handlers.) To add a type: add it here and give it a handler; the engine, validator, API and editor need no other change.
 */
export interface StageTypeSpec {
  type: StageType;
  label: string;
  description: string;
  configSchema: z.ZodType;
  defaultConfig: Record<string, unknown>;
  defaultGate: Gate;
  /** The prompt template a new stage of this type starts with. Absent: the type has no prompt of its own. */
  defaultPrompt?: string;
  /** Uses a model (so the editor offers provider/model). */
  usesModel: boolean;
  /** Runs inside the engine (a routing decision) rather than a handler. */
  engineOnly?: boolean;
}

/** Roles a custom stage may use. All read-only: a workflow cannot hand an agent write access the code does not already grant to its own stages. */
export const READ_ONLY_ROLES = ["classifier", "requirements-analyst", "spec-reviewer", "qa-reviewer", "security-reviewer", "final-reviewer"] as const satisfies readonly AgentRole[];
export const REVIEW_ROLES = ["qa-reviewer", "spec-reviewer", "security-reviewer", "final-reviewer"] as const;
export const CHECK_COMMANDS = ["install", "build", "typecheck", "lint", "test"] as const;

export const DEFAULT_AGENT_PROMPT = `Work on ticket {{ticket.identifier}}: {{ticket.title}}

{{ticket.description}}

Repository: {{repo.path}} (project {{project.name}}).
You are the "{{stage.name}}" step of the "{{workflow.name}}" workflow. You may read the repository but not change it.

Earlier findings, if any:
{{findings}}

Answer concisely and concretely.`;

export const DEFAULT_REVIEW_PROMPT = `Review the changes made for ticket {{ticket.identifier}}: {{ticket.title}}

{{ticket.description}}

The branch was created from {{repo.baseSha}} in {{repo.path}}. Inspect the change with \`git diff {{repo.baseSha}}...HEAD\` and read the code around it. You may not modify anything.

Report every real problem as a finding with a severity: critical (a security or data-loss problem), blocker, major or minor. Set the verdict to "approve" only when nothing blocking remains, otherwise "changes_required". Do not invent findings: a clean change has an empty list.`;

const roleOf = (roles: readonly [string, ...string[]], dflt: string) => z.enum(roles).default(dflt as never);

export const STAGE_TYPE_SPECS: Record<StageType, StageTypeSpec> = {
  factory: {
    type: "factory", label: "Factory stage", usesModel: true,
    description: "One of the factory's built-in stages (specification, implementation, testing, review, pull request...). Its behaviour is fixed in code; you configure its order, limits, extra instructions, model and routing.",
    configSchema: z.object({}).strict(), defaultConfig: {}, defaultGate: { type: "result_ok" },
  },
  agent: {
    type: "agent", label: "Agent", usesModel: true,
    description: "Runs a read-only AI agent with your prompt and records its answer as the stage output.",
    configSchema: z.object({ role: roleOf(READ_ONLY_ROLES, "requirements-analyst") }).strict(), defaultConfig: { role: "requirements-analyst" },
    defaultGate: { type: "fields_present", fields: ["text"] }, defaultPrompt: DEFAULT_AGENT_PROMPT,
  },
  review: {
    type: "review", label: "Review", usesModel: true,
    description: "Runs a read-only reviewer that returns a verdict and structured findings. Blocking findings route as failures; a critical finding always stops the job for a person.",
    configSchema: z.object({ role: roleOf(REVIEW_ROLES, "qa-reviewer"), blocking: z.array(z.enum(["critical", "blocker", "major", "minor"])).default(["blocker", "major"]) }).strict(),
    defaultConfig: { role: "qa-reviewer", blocking: ["blocker", "major"] },
    defaultGate: { type: "all", of: [{ type: "verdict_approved" }, { type: "no_blocking_findings" }] }, defaultPrompt: DEFAULT_REVIEW_PROMPT,
  },
  check: {
    type: "check", label: "Command check", usesModel: false,
    description: "Runs one of the project's configured commands (install, build, typecheck, lint, test) in the sandbox. The command text comes from the project's settings, never from the workflow.",
    configSchema: z.object({ command: z.enum(CHECK_COMMANDS).default("test") }).strict(), defaultConfig: { command: "test" },
    defaultGate: { type: "exit_code_zero" },
  },
  conditional: {
    type: "conditional", label: "Condition", usesModel: false, engineOnly: true,
    description: "Evaluates a condition and routes to one stage or another. Does no work of its own.",
    configSchema: z.object({ condition: Condition, then: z.union([stageId, z.literal(COMPLETE)]), else: z.union([stageId, z.literal(COMPLETE)]) }).strict(),
    defaultConfig: {}, defaultGate: { type: "result_ok" },
  },
};
