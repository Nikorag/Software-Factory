/** Provider-neutral agent contract. Claude Code and the local model both implement `Agent`. */
export type AgentRole =
  | "requirements-analyst" | "spec-writer" | "spec-reviewer" | "implementer"
  | "qa-reviewer" | "security-reviewer" | "final-reviewer" | "classifier" | "assistant";

/** What an agent may do. Enforced by the adapter (permission rules) and re-verified by the factory afterwards. */
export type PermissionProfile = "read-only" | "spec-writer" | "implementer";

export interface AgentRequest {
  role: AgentRole;
  profile: PermissionProfile;
  prompt: string; // sent on stdin / request body, never on a command line
  cwd: string; // always a job worktree for tool-using profiles
  model?: string; // undefined or "default": provider's default
  systemPrompt?: string; // appended to the provider's system prompt
  jsonSchema?: Record<string, unknown>; // ask for structured output
  timeoutMs: number;
  signal?: AbortSignal; // cancellation / emergency stop
  protectedPaths?: string[]; // globs the agent may not write
  access?: "restricted" | "unrestricted"; // implementer only: "unrestricted" = Claude Code auto mode, no factory tool lists
  bashAllow?: string[]; // extra shell command prefixes, e.g. a project's "pnpm test"
  resumeSessionId?: string; // continue an earlier session (remediation)
  persistSession?: boolean;
  logFile?: string; // raw stdout/stderr capture
}

export type AgentFailure = "timeout" | "cancelled" | "auth" | "rate_limited" | "transient" | "invalid_output" | "error";

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  sessionId?: string;
  /** Claude Code's list-price estimate of the run (`costBasis: "list"`). NOT a charge: subscription auth is not billed per token. */
  costUsd?: number;
  usage?: Record<string, unknown>;
  numTurns?: number;
  denials: { tool: string; input: string }[]; // actions the permission system refused
  exitCode: number | null;
  durationMs: number;
  failure?: AgentFailure;
  error?: string;
  logFile?: string;
}

export interface Agent {
  readonly provider: "anthropic" | "local";
  run(req: AgentRequest): Promise<AgentResult>;
}

/** Whether a failure is worth retrying automatically. Auth and invalid output are not: they need a human or a different prompt. */
export const isTransientFailure = (f?: AgentFailure): boolean => f === "timeout" || f === "transient" || f === "rate_limited";
