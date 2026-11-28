import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, decisions } from "../db/schema.js";
import { skillsPromptBlock } from "../config/skills.js";
import type { EffectiveSkill } from "../config/skills.js";
import { git as realGit, type GitFn } from "../repo/git.js";
import { findProtectedChanges } from "./guard.js";
import { writeLimits } from "./usage.js";
import { ROLE_PROFILE, rolePrompt } from "./roles.js";
import type { ModelRouter, Route, TaskKind } from "./router.js";
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
  lessonIds?: number[]; // the project lessons the caller put in the prompt (recorded in the invocation's usage, so every run shows what it saw)
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
    projectBashAny?: (projectId?: string) => boolean; // per project opt-in: any Bash command (bar the deny list) for the restricted implementer
    skills?: (projectId?: string) => EffectiveSkill[]; // the effective skills (profile's, overridden by the project's and the repo file's); see effectiveSkills
    readGrants?: (jobId: string) => string[]; // folders outside the worktree a person approved this job's agents to read
  }) {}

  async run(step: RunStep): Promise<AgentResult & { route: Route; violations: string[] }> {
    const { db, router } = this.d;
    const git = this.d.git ?? realGit;
    const profile = ROLE_PROFILE[step.role];
    const route = router.route(step.task, step.projectId); // fail on bad config before recording anything
    const caps = router.capabilities(route);
    // A plugin that cannot write the worktree may only serve the read-only profile (reviewers, classification): decided from its declared capabilities.
    if (profile !== "read-only" && !(caps.tools && caps.writesWorktree)) {
      return { ok: false, text: "", denials: [], exitCode: null, durationMs: 0, failure: "error", error: `plugin ${route.plugin} cannot write the worktree and may only serve read-only requests (role ${step.role})`, route, violations: [] };
    }
    const access = profile === "implementer" ? (this.d.access?.(step.projectId) ?? "restricted") : "restricted";
    if (access === "unrestricted" && step.jobId) {
      db.insert(decisions).values({ jobId: step.jobId, kind: "agent.unrestricted", decision: `${step.role} runs with unrestricted access (Claude Code auto mode)`, rationale: "agentAccess is `unrestricted`", actor: "factory" }).run();
    }
    // Skills are read now, before anything is recorded: a missing or oversize file fails the run with a clear error instead of being dropped.
    const skills = this.d.skills?.(step.projectId) ?? [];
    const skillBlock = skillsPromptBlock(skills);
    if (skills.length && step.jobId) {
      db.insert(decisions).values({ jobId: step.jobId, kind: "agent.skills", decision: `${step.role} runs with skills: ${skills.map((s) => s.name).join(", ")}`, rationale: skills.some((s) => s.fromRepo) ? "configured in projects.yaml / the profile settings (operator-trusted) and the repository's .software-factory.yml (read from the committed default branch)" : "configured in projects.yaml / the profile settings (operator-trusted)", actor: "factory" }).run();
    }
    const logFile = join(this.d.logDir, step.jobId ?? "_unattached", `${Date.now()}-${step.role}.log`);
    const grants = step.jobId ? (this.d.readGrants?.(step.jobId) ?? []) : [];
    const row = step.jobId
      ? db.insert(agentInvocations).values({
          jobId: step.jobId, stageExecutionId: step.executionId ?? null, agent: `${route.instance}/${step.role}`, model: route.model, cwd: step.cwd, logPath: logFile,
        }).returning({ id: agentInvocations.id }).get()
      : undefined;

    // The first line of the run's log is the prompt, so the dashboard's conversation view reads from the very start.
    try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `${JSON.stringify({ type: "factory_prompt", role: step.role, text: step.prompt })}\n`); } catch { /* the log is a convenience, never a reason to fail the run */ }

    // A tool-using plugin could change files even when asked to only read: verify the worktree is untouched afterwards.
    const before = profile === "read-only" && caps.tools ? await git(step.cwd, ["status", "--porcelain", "--untracked-files=all"]).catch(() => null) : null;
    const result = await router.run(step.task, {
      role: step.role, profile, prompt: step.prompt, cwd: step.cwd, timeoutMs: step.timeoutMs, signal: step.signal,
      systemPrompt: readNote(rolePrompt(step.role), grants) + skillBlock, readPaths: grants, protectedPaths: this.d.protectedPaths, access, bashAllow: [...(step.bashAllow ?? []), ...(this.d.projectBashAllow?.(step.projectId) ?? [])],
      bashAny: profile === "implementer" && access === "restricted" && (this.d.projectBashAny?.(step.projectId) ?? false),
      jsonSchema: step.jsonSchema, resumeSessionId: step.resumeSessionId, persistSession: profile === "implementer", logFile,
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
      usageJson: JSON.stringify({ estimatedListCostUsd: result.costUsd, sessionId: result.sessionId, numTurns: result.numTurns, failure: result.failure, denials: result.denials.length, denialDetails: result.denials.slice(0, 10), violations: violations.length, usage: result.usage, lessons: step.lessonIds ?? [] }),
    }).where(eq(agentInvocations.id, row.id)).run();

    if (violations.length) return { ...result, ok: false, failure: "error", error: `boundary violation: ${violations.join("; ")}`, violations };
    return { ...result, violations };
  }
}
