import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, decisions } from "../db/schema.js";
import { git as realGit, type GitFn } from "../repo/git.js";
import { findProtectedChanges } from "./guard.js";
import { ROLE_PROFILE, rolePrompt } from "./roles.js";
import { ConfigError } from "../config/load.js";
import type { ModelRouter, Route, StageModel, TaskKind } from "./router.js";
import type { AgentResult, AgentRole } from "./types.js";

export interface RunStep {
  projectId?: string; // selects that project's model overrides
  jobId?: string; // omitted for job-less runs (project onboarding): nothing is recorded in the DB, the log file still is
  executionId?: number;
  task: TaskKind;
  role: AgentRole;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  baseRef?: string; // enables the protected-path diff check for tool-using roles
  bashAllow?: string[];
  jsonSchema?: Record<string, unknown>;
  resumeSessionId?: string;
  /** The workflow stage's model choice, applied by the router on top of the configured route. */
  stageModel?: StageModel;
}

/**
 * The single entry point stage handlers use to run an agent. It fixes the permission profile from the role,
 * records the invocation, and independently verifies afterwards that the agent respected its boundaries.
 */
export class AgentRunner {
  constructor(private readonly d: { db: FactoryDb; router: ModelRouter; logDir: string; protectedPaths: string[]; git?: GitFn }) {}

  async run(step: RunStep): Promise<AgentResult & { route: Route; violations: string[] }> {
    const { db, router } = this.d;
    const git = this.d.git ?? realGit;
    const profile = ROLE_PROFILE[step.role];
    const route = router.route(step.task, step.projectId, step.stageModel); // fail on bad config before recording anything
    // Tools (file edits, shell) exist only in Claude Code: whatever a workflow asks for, a tool-using role never runs on the local model.
    if (profile !== "read-only" && route.provider === "local") throw new ConfigError(`the ${step.role} role needs file and shell tools, so it cannot use the local model`);
    const logFile = join(this.d.logDir, step.jobId ?? "_unattached", `${Date.now()}-${step.role}.log`);
    const row = step.jobId
      ? db.insert(agentInvocations).values({
          jobId: step.jobId, stageExecutionId: step.executionId ?? null, agent: `${route.provider}/${step.role}`, model: route.model, cwd: step.cwd, logPath: logFile,
        }).returning({ id: agentInvocations.id }).get()
      : undefined;

    // The first line of the run's log is the prompt, so the dashboard's conversation view reads from the very start.
    try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `${JSON.stringify({ type: "factory_prompt", role: step.role, text: step.prompt })}\n`); } catch { /* the log is a convenience, never a reason to fail the run */ }

    const before = profile === "read-only" && route.provider === "anthropic" ? await git(step.cwd, ["status", "--porcelain", "--untracked-files=all"]).catch(() => null) : null;
    const result = await router.run(step.task, {
      role: step.role, profile, prompt: step.prompt, cwd: step.cwd, timeoutMs: step.timeoutMs, signal: step.signal,
      systemPrompt: rolePrompt(step.role), protectedPaths: this.d.protectedPaths, bashAllow: step.bashAllow,
      jsonSchema: step.jsonSchema, resumeSessionId: step.resumeSessionId, persistSession: profile === "implementer", logFile,
    }, step.projectId, step.stageModel);

    const violations: string[] = [];
    if (profile !== "read-only" && step.baseRef) {
      violations.push(...(await findProtectedChanges(step.cwd, step.baseRef, this.d.protectedPaths, git)).map((f) => `protected path changed: ${f}`));
    }
    if (before !== null) {
      const after = await git(step.cwd, ["status", "--porcelain", "--untracked-files=all"]).catch(() => null);
      if (after !== null && after !== before) violations.push("read-only agent modified the worktree");
    }
    if (violations.length && step.jobId) {
      db.insert(decisions).values({ jobId: step.jobId, kind: "agent.violation", decision: `${step.role}: ${violations.join("; ")}`, rationale: logFile, actor: "factory" }).run();
    }
    if (row) db.update(agentInvocations).set({
      exitCode: result.exitCode, durationMs: result.durationMs,
      usageJson: JSON.stringify({ estimatedListCostUsd: result.costUsd, sessionId: result.sessionId, numTurns: result.numTurns, failure: result.failure, denials: result.denials.length, denialDetails: result.denials.slice(0, 10), violations: violations.length, usage: result.usage }),
    }).where(eq(agentInvocations.id, row.id)).run();

    if (violations.length) return { ...result, ok: false, failure: "error", error: `boundary violation: ${violations.join("; ")}`, violations };
    return { ...result, violations };
  }
}
