import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, decisions } from "../db/schema.js";
import { git as realGit, type GitFn } from "../repo/git.js";
import { findProtectedChanges } from "./guard.js";
import { writeLimits } from "./usage.js";
import { ROLE_PROFILE, rolePrompt } from "./roles.js";
import type { ModelRouter, Route, TaskKind } from "./router.js";
import type { McpGrant } from "./mcp.js";
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
}

/** Tells the agent which folders outside the worktree a person has let it read. */
const readNote = (prompt: string, grants: string[]): string => (grants.length
  ? `${prompt}\n\nA person has allowed you to READ these folders outside the worktree (read-only; you still cannot write there): ${grants.map((g) => g.replace(/\/\*\*$/, "/")).join(", ")}.`
  : prompt);

/**
 * The single entry point stage handlers use to run an agent. It fixes the permission profile from the role,
 * records the invocation, and independently verifies afterwards that the agent respected its boundaries.
 */
export class AgentRunner {
  constructor(private readonly d: {
    db: FactoryDb; router: ModelRouter; logDir: string; protectedPaths: string[]; git?: GitFn;
    usageFile?: string; // where the latest Claude plan-limit reading is kept
    access?: (projectId?: string) => "restricted" | "unrestricted"; // per project; default restricted
    projectBashAllow?: (projectId?: string) => string[]; // per project extra shell prefixes for the restricted implementer
    readGrants?: (jobId: string) => string[]; // folders outside the worktree a person approved this job's agents to read
    mcp?: (projectId?: string) => McpGrant | undefined; // the MCP servers (project selection, else profile default) with their secrets; undefined = none
  }) {}

  async run(step: RunStep): Promise<AgentResult & { route: Route; violations: string[] }> {
    const { db, router } = this.d;
    const git = this.d.git ?? realGit;
    const profile = ROLE_PROFILE[step.role];
    const route = router.route(step.task, step.projectId); // fail on bad config before recording anything
    const access = profile === "implementer" ? (this.d.access?.(step.projectId) ?? "restricted") : "restricted";
    if (access === "unrestricted" && step.jobId) {
      db.insert(decisions).values({ jobId: step.jobId, kind: "agent.unrestricted", decision: `${step.role} runs with unrestricted access (Claude Code auto mode)`, rationale: "agentAccess is `unrestricted`", actor: "factory" }).run();
    }
    // MCP is a Claude Code feature: the local provider is a plain chat endpoint with no tool use, so it is never given any server (or secret).
    const mcp = route.provider === "anthropic" ? this.d.mcp?.(step.projectId) : undefined;
    const mcpNames = mcp?.names ?? [];
    if (mcpNames.length && step.jobId) {
      db.insert(decisions).values({ jobId: step.jobId, kind: "agent.mcp", decision: `${step.role} runs with MCP servers: ${mcpNames.join(", ")}`, rationale: "selected for this project (or the profile default)", actor: "factory" }).run(); // names only
    }
    const logFile = join(this.d.logDir, step.jobId ?? "_unattached", `${Date.now()}-${step.role}.log`);
    const grants = step.jobId ? (this.d.readGrants?.(step.jobId) ?? []) : [];
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
      systemPrompt: readNote(rolePrompt(step.role), grants), readPaths: grants, protectedPaths: this.d.protectedPaths, access, bashAllow: [...(step.bashAllow ?? []), ...(this.d.projectBashAllow?.(step.projectId) ?? [])],
      ...(mcp ? { mcp } : {}), jsonSchema: step.jsonSchema, resumeSessionId: step.resumeSessionId, persistSession: profile === "implementer", logFile,
    }, step.projectId);

    if (result.limits && this.d.usageFile) writeLimits(this.d.usageFile, result.limits);
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
      usageJson: JSON.stringify({ estimatedListCostUsd: result.costUsd, sessionId: result.sessionId, numTurns: result.numTurns, failure: result.failure, denials: result.denials.length, denialDetails: result.denials.slice(0, 10), violations: violations.length, usage: result.usage, ...(mcpNames.length ? { mcpServers: mcpNames } : {}) }),
    }).where(eq(agentInvocations.id, row.id)).run();

    if (violations.length) return { ...result, ok: false, failure: "error", error: `boundary violation: ${violations.join("; ")}`, violations };
    return { ...result, violations };
  }
}
