import { realpathSync, statSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { LoadedConfig } from "../config/schema.js";
import { STAGES } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, artifacts, decisions, jobs, linearOutbox, projects, stageExecutions, worktrees } from "../db/schema.js";
import * as control from "../core/control.js";
import type { Engine } from "../core/engine.js";
import { answerJob, archiveJob, cancelJob, deleteJob, getJob, isAwaitingMerge, JobError, retryJob } from "../core/jobs.js";
import { listFeedback, requestChanges } from "../core/feedback.js";
import { decideRequest, listRequests } from "../core/approvals.js";
import { confirmGate, returnGate } from "../core/gates.js";
import { WorktreeError } from "../repo/worktrees.js";
import type { Scheduler } from "../service/scheduler.js";
import { cachedSystemInfo, counts, type HealthChecker } from "../service/metrics.js";
import { readConversation } from "../agents/transcript.js";
import { exhaustedLimit, readLimits, usageFile, windowIsCurrent } from "../agents/usage.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { onboardingOf, type CheckRecord } from "../repo/readiness.js";
import { latestPlan } from "../planning/plan.js";
import type { RepoReport } from "../repo/inspect.js";
import { registerBoardRoutes } from "./board-routes.js";
import { registerBitbucketRoutes } from "./bitbucket-routes.js";
import { registerGithubIssuesRoutes } from "./github-issues-routes.js";
import { registerTrackersRoutes } from "./trackers-routes.js";
import { registerJiraRoutes } from "./jira-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerChatRoutes, type ChatRun } from "./chat.js";

export interface ApiDeps {
  db: FactoryDb;
  logger: Logger;
  config?: LoadedConfig;
  engine?: Engine;
  scheduler?: Scheduler;
  health?: HealthChecker;
  dataDir?: string;
  /** Removes a job's worktree and local branch (the "also remove the worktree" option when deleting a job). */
  worktrees?: Pick<import("../repo/worktrees.js").WorktreeManager, "remove">;
  /** Settings UI + setup wizard. Absent in tests that do not exercise them. */
  profiles?: import("./profile-routes.js").ProfileDeps;
  bitbucket?: Omit<import("./bitbucket-routes.js").BitbucketRouteDeps, "config">;
  jira?: Omit<import("./jira-routes.js").JiraRouteDeps, "db" | "config">;
  githubIssues?: { gh?: import("../github/client.js").GhExec };
  updates?: { status(): Promise<import("../service/versions.js").UpdateStatus>; refresh(): Promise<import("../service/versions.js").UpdateStatus> };
  settings?: Omit<import("./settings-routes.js").SettingsDeps, "db" | "config">;
  /** Runs one read-only assistant turn for the job chat. Absent: the chat endpoint answers 503. */
  chat?: { run: ChatRun };
  /** Begins a graceful shutdown of this service (how `software-factory shutdown` stops it without signalling a pid). */
  shutdown?: () => void;
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const baseJobRow = (j: typeof jobs.$inferSelect, planningMode: string) => ({
  planningMode, // how this job is planned: the dashboard draws the matching flow chart
  id: j.id, key: j.externalKey, title: j.title, project: j.projectId, workflow: j.workflow, stage: j.stage, status: j.status, heldFromStage: j.heldFromStage,
  remediationAttempts: j.remediationAttempts, stageAttempts: j.stageAttempts, autonomous: j.autonomous, dryRun: j.dryRun, prUrl: j.prUrl,
  lastError: j.lastError, notBefore: ms(j.notBefore), createdAt: ms(j.createdAt), updatedAt: ms(j.updatedAt), archivedAt: ms(j.archivedAt),
});
/**
 * Whether an agent run is over. `exitCode` alone is not enough: a run killed by a signal (timeout, cancel, emergency stop) or a failed
 * local-model call records a duration but no exit code, and a run cut short by a service crash records neither. So a run is finished
 * when it recorded an outcome (exit code or duration), or when its stage execution is no longer "started" (crash recovery closes those),
 * or, for a run with no stage execution, when its job is not running.
 */
export function runFinished(inv: { exitCode: number | null; durationMs: number | null; stageExecutionId: number | null }, execOutcome: string | undefined, jobStatus: string | undefined): boolean {
  if (inv.exitCode !== null || inv.durationMs !== null) return true;
  if (inv.stageExecutionId !== null && execOutcome !== undefined) return execOutcome !== "started";
  return jobStatus !== "running";
}

const clip = (s: string | null, n = 4000) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

/** Last `tail` bytes of a file, only if it lives under <dataDir>/logs (no path traversal, no symlink escapes). */
export function readLogTail(dataDir: string, path: string, tail: number): { text: string; truncated: boolean; size: number } | null {
  try {
    const root = realpathSync(join(dataDir, "logs"));
    const real = realpathSync(resolve(path));
    if (real !== root && !real.startsWith(root + sep)) return null;
    const size = statSync(real).size;
    const len = Math.min(size, tail);
    const fd = openSync(real, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return { text: buf.toString("utf8"), truncated: size > len, size };
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** Delete an agent log, only if it lives under <dataDir>/logs (same containment rule as readLogTail). */
function removeLog(dataDir: string, path: string): void {
  try {
    const root = realpathSync(join(dataDir, "logs"));
    const real = realpathSync(resolve(path));
    if (real.startsWith(root + sep)) unlinkSync(real);
  } catch { /* already gone */ }
}

export function registerApiRoutes(app: FastifyInstance, d: ApiDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const { db } = d;
  const actor = "dashboard";
  /** A job that is in (or was held at) a Spec Kit stage is a Spec Kit job whatever the profile says now; otherwise the profile's current mode. */
  const jobRow = (j: typeof jobs.$inferSelect) => baseJobRow(j, /^SPECIFICATION_/.test(j.stage) || /^SPECIFICATION_/.test(j.heldFromStage ?? "") ? "speckit" : d.config?.factory.workflow.planning_mode ?? "speckit");
  const systemInfo = cachedSystemInfo(); // polled every few seconds: do not spawn memory_pressure on every request

  /** Latest Claude plan-limit reading (from Claude Code's own stream) and the list-price estimate of recent runs. Never a charge: subscription auth is not billed per token. */
  const claudeUsage = () => {
    const l = d.dataDir ? readLimits(usageFile(d.dataDir)) : null, now = Date.now();
    const rows = db.select({ at: agentInvocations.startedAt, u: agentInvocations.usageJson }).from(agentInvocations).where(gte(agentInvocations.startedAt, new Date(now - 7 * 86_400_000))).all();
    let day = 0, week = 0;
    for (const r of rows) {
      let c = 0; try { c = Number((JSON.parse(r.u ?? "{}") as { estimatedListCostUsd?: number }).estimatedListCostUsd) || 0; } catch { /* no usage recorded */ }
      week += c; if (r.at.getTime() >= now - 86_400_000) day += c;
    }
    return {
      limits: l ? { ...l, fiveHour: windowIsCurrent(l.fiveHour, now) ? l.fiveHour : null, sevenDay: windowIsCurrent(l.sevenDay, now) ? l.sevenDay : null } : null,
      /** The window blocking new jobs right now (the rule lives in exhaustedLimit), or null. */
      exhausted: exhaustedLimit(l, now),
      estimatedListCostUsd: { last24h: Math.round(day * 100) / 100, last7d: Math.round(week * 100) / 100 },
    };
  };

  app.get("/api/overview", async () => {
    const all = db.select().from(jobs).where(isNull(jobs.archivedAt)).orderBy(desc(jobs.updatedAt)).limit(300).all();
    let finishedSeen = 0;
    return {
      control: control.getControl(db),
      counts: counts(db),
      active: all.filter((j) => j.status === "running").map(jobRow),
      queued: all.filter((j) => (j.status === "queued" || j.status === "waiting") && !isAwaitingMerge(j)).slice(0, 30).map(jobRow),
      // Jobs awaiting a human merge are exempt from the cap: they still need an action and must not fall off the list.
      recent: all.filter((j) => isAwaitingMerge(j) || (["done", "failed", "cancelled"].includes(j.status) && finishedSeen++ < 20)).map(jobRow),
      engineActive: d.engine?.activeJobIds() ?? [],
      scheduler: d.scheduler?.status() ?? null,
      system: await systemInfo(d.dataDir ?? "."),
      health: (await d.health?.check()) ?? [],
      projectCount: d.config?.projects.projects.length,
      mergeMode: d.config?.factory.mergeMode ?? "pr-only",
      dryRun: d.config?.factory.dryRun ?? false,
      claudeUsage: claudeUsage(),
    };
  });

  /** Paged, filterable job list. archived: "hide" (default) | "only" | "all". q matches ticket key, project, stage or the last error. */
  app.get<{ Querystring: { status?: string; project?: string; q?: string; archived?: string; page?: string; pageSize?: string; limit?: string } }>("/api/jobs", async (req) => {
    const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? req.query.limit) || 25, 1), 200);
    const conds = [];
    if (req.query.status) conds.push(eq(jobs.status, req.query.status as typeof jobs.$inferSelect["status"]));
    if (req.query.project) conds.push(eq(jobs.projectId, req.query.project));
    if (req.query.archived === "only") conds.push(isNotNull(jobs.archivedAt));
    else if (req.query.archived !== "all") conds.push(isNull(jobs.archivedAt));
    const text = (req.query.q ?? "").trim().slice(0, 100);
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(or(sql`${jobs.externalKey} like ${like} escape '\\'`, sql`${jobs.projectId} like ${like} escape '\\'`, sql`${jobs.stage} like ${like} escape '\\'`, sql`coalesce(${jobs.lastError}, '') like ${like} escape '\\'`)!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const total = db.select({ n: sql<number>`count(*)` }).from(jobs).where(where).get()?.n ?? 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
    const rows = db.select().from(jobs).where(where).orderBy(desc(jobs.updatedAt)).limit(pageSize).offset((page - 1) * pageSize).all();
    return { jobs: rows.map(jobRow), total, page, pageSize, pages };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = db.select().from(jobs).where(eq(jobs.id, req.params.id)).get();
    if (!job) return reply.code(404).send({ error: "no such job" });
    const id = job.id;
    const execs = db.select().from(stageExecutions).where(eq(stageExecutions.jobId, id)).orderBy(asc(stageExecutions.id)).all();
    const outcomeOf = new Map(execs.map((e) => [e.id, e.outcome]));
    return {
      job: jobRow(job),
      remediationCap: d.engine?.remediationCap(job) ?? d.config?.projects.projects.find((p) => p.id === job.projectId)?.overrides?.maxRemediationAttempts ?? d.config?.factory.maxRemediationAttempts ?? 3,
      stageOrder: STAGES,
      executions: execs
        .map((e) => ({ id: e.id, stage: e.stage, attempt: e.attempt, outcome: e.outcome, error: clip(e.error), output: clip(e.outputJson, 1500), startedAt: ms(e.startedAt), finishedAt: ms(e.finishedAt) })),
      decisions: db.select().from(decisions).where(eq(decisions.jobId, id)).orderBy(asc(decisions.id)).all()
        .map((x) => ({ id: x.id, kind: x.kind, decision: clip(x.decision, 500), rationale: clip(x.rationale, 1500), actor: x.actor, at: ms(x.createdAt) })),
      invocations: db.select().from(agentInvocations).where(eq(agentInvocations.jobId, id)).orderBy(asc(agentInvocations.id)).all()
        .map((a) => ({ id: a.id, stageExecutionId: a.stageExecutionId, agent: a.agent, model: a.model, exitCode: a.exitCode, durationMs: a.durationMs, finished: runFinished(a, a.stageExecutionId === null ? undefined : outcomeOf.get(a.stageExecutionId), job.status), usage: a.usageJson ? JSON.parse(a.usageJson) : null, hasLog: Boolean(a.logPath), at: ms(a.startedAt) })),
      artifacts: db.select().from(artifacts).where(eq(artifacts.jobId, id)).orderBy(asc(artifacts.id)).all().filter((a) => !a.kind.startsWith("step:"))
        .map((a) => ({ kind: a.kind, path: a.path, bytes: a.bytes, at: ms(a.createdAt) })),
      /** The prompt Haiku wrote for the implementer and its acceptance criteria (haiku_prompt mode); null in Spec Kit mode or before it exists. */
      plan: latestPlan(db, id) ?? null,
      worktree: db.select().from(worktrees).where(eq(worktrees.jobId, id)).get() ?? null,
      /** What the job's agents were refused that a person can allow (Approve / Deny on the job page), oldest first. */
      permissions: listRequests(db, id).map((r) => ({ id: r.id, stage: r.stage, tool: r.tool, kind: r.kind, path: r.path, grant: r.grantPath.replace(/\/\*\*$/, "/"), folder: r.grantPath.endsWith("/**"), status: r.status, reason: r.reason, at: ms(r.createdAt), decidedAt: ms(r.decidedAt) })),
      /** Change requests on the job's pull request (job page or `/software-factory` PR comments), oldest first. */
      feedback: listFeedback(db, id).map((f) => ({ id: f.id, source: f.source, author: f.author, body: clip(f.body, 4000), path: f.path, line: f.line, url: f.url, status: f.status, note: clip(f.note, 1000), at: ms(f.createdAt), updatedAt: ms(f.updatedAt) })),
      outbox: db.select().from(linearOutbox).where(eq(linearOutbox.jobId, id)).orderBy(asc(linearOutbox.id)).all()
        .map((o) => ({ id: o.id, kind: o.kind, status: o.status, attempts: o.attempts, lastError: clip(o.lastError, 300) })),
    };
  });

  app.get<{ Params: { id: string; iid: string }; Querystring: { tail?: string } }>("/api/jobs/:id/invocations/:iid/log", async (req, reply) => {
    const inv = db.select().from(agentInvocations).where(and(eq(agentInvocations.id, Number(req.params.iid)), eq(agentInvocations.jobId, req.params.id))).get();
    if (!inv?.logPath || !d.dataDir) return reply.code(404).send({ error: "no log" });
    const out = readLogTail(d.dataDir, inv.logPath, Math.min(Number(req.query.tail) || 20_000, 200_000));
    if (!out) return reply.code(404).send({ error: "log not available" });
    return reply.header("Content-Type", "text/plain; charset=utf-8").header("X-Log-Truncated", String(out.truncated)).send(out.text);
  });

  /** The back-and-forth of one agent run, as display turns. Poll with `after` = the previous `offset` to follow a run live. */
  app.get<{ Params: { id: string; iid: string }; Querystring: { after?: string } }>("/api/jobs/:id/invocations/:iid/conversation", async (req, reply) => {
    const inv = db.select().from(agentInvocations).where(and(eq(agentInvocations.id, Number(req.params.iid)), eq(agentInvocations.jobId, req.params.id))).get();
    if (!inv?.logPath || !d.dataDir) return reply.code(404).send({ error: "no conversation recorded for this run" });
    const out = readConversation(d.dataDir, inv.logPath, Number(req.query.after) || 0);
    if (!out) return reply.code(404).send({ error: "log not available" });
    const outcome = inv.stageExecutionId === null ? undefined : db.select({ o: stageExecutions.outcome }).from(stageExecutions).where(eq(stageExecutions.id, inv.stageExecutionId)).get()?.o;
    const status = db.select({ s: jobs.status }).from(jobs).where(eq(jobs.id, inv.jobId)).get()?.s;
    return { ...out, done: runFinished(inv, outcome, status) && !out.more, agent: inv.agent, model: inv.model, cwd: inv.cwd, startedAt: ms(inv.startedAt), durationMs: inv.durationMs }; // a finished run with unread log still has pages to send
  });

  app.get("/api/projects", async () => {
    const rows = db.select().from(projects).all();
    return {
      projects: (d.config?.projects.projects ?? []).map((p) => {
        const row = rows.find((r) => r.id === p.id);
        const report = row?.validationJson ? (JSON.parse(row.validationJson) as { ok?: boolean; findings?: { severity: string; code: string; message: string }[]; branchProtection?: { status: string } }) : null;
        return {
          id: p.id, name: p.name, enabled: p.enabled, autonomy: p.autonomy, repository: p.repository, managed: p.managed, defaultBranch: p.defaultBranch, githubAccount: p.github.account ?? null, host: p.host, bitbucketRepo: p.bitbucket.repo ?? null, bitbucketCredential: p.bitbucket.credential, overrides: p.overrides ?? null, specKit: p.specKit, allowLoopback: p.allowLoopback, agentBashAllow: p.agentBashAllow, gates: p.gates, skills: p.skills,
          tracker: p.tracker ?? null, linear: p.linear ?? null, githubRepo: p.github.repo ?? null, commands: p.commands,
          onboarding: onboardingOf(p, row?.validationJson ? (JSON.parse(row.validationJson) as RepoReport) : null, row?.checkJson ? (JSON.parse(row.checkJson) as CheckRecord) : null, d.config?.factory.workflow.planning_mode),
          validation: report ? { ok: report.ok ?? false, at: ms(row?.lastValidatedAt), protection: report.branchProtection?.status ?? "unknown", findings: (report.findings ?? []).filter((f) => f.severity !== "info").map((f) => `${f.severity}: ${f.message}`) } : null,
          activeJobs: db.select().from(jobs).where(and(eq(jobs.projectId, p.id), inArray(jobs.status, ["queued", "running", "waiting"]))).all().length,
        };
      }),
    };
  });

  app.get("/api/update", async () => (await d.updates?.status()) ?? { current: null, latest: null, available: false, checkedAt: null });
  /** "Check for updates" in Settings: ask git now instead of using the cached answer. Read-only on the install (it only fetches tags). */
  app.post("/api/update/check", { preHandler: requireToken }, async () => (await d.updates?.refresh()) ?? { current: null, latest: null, available: false, checkedAt: null });

  /** `?refresh=1` re-runs every probe now (sharing any probe already running) instead of using cached results, e.g. right after `gh auth login`. */
  app.get<{ Querystring: { refresh?: string } }>("/api/health", async (req) => {
    const refresh = ["1", "true"].includes(req.query.refresh ?? "");
    return { system: await systemInfo(d.dataDir ?? "."), health: (await d.health?.check({ refresh })) ?? [], scheduler: d.scheduler?.status() ?? null };
  });

  // ---- controls: every one requires the bearer token ----
  const act = (name: string, fn: (reason?: string) => unknown) =>
    app.post<{ Body?: { reason?: string } }>(`/api/control/${name}`, { preHandler: requireToken }, async (req) => {
      const r = (req.body && typeof req.body.reason === "string" ? req.body.reason : undefined)?.slice(0, 200);
      d.logger.warn({ control: name, actor }, "control action");
      fn(r);
      return { ok: true, control: control.getControl(db) };
    });
  act("pause", (r) => control.pause(db, actor, r));
  act("resume", () => control.resume(db, actor));
  act("clear-stop", () => control.clearEmergencyStop(db, actor));
  act("stop", (r) => {
    control.emergencyStop(db, actor, r ?? "emergency stop from the dashboard"); // 1. nothing new starts
    d.engine?.abortActive("estop"); //                                           2. running agents are terminated now, not at the next heartbeat
  });

  // Graceful shutdown, the same as SIGTERM. Answered first; the service then stops in the background.
  app.post("/api/control/shutdown", { preHandler: requireToken }, async (_req, reply) => {
    if (!d.shutdown) return reply.code(501).send({ error: "this service cannot be shut down over the API" });
    d.logger.warn({ control: "shutdown", actor }, "control action");
    const go = d.shutdown;
    setTimeout(go, 50).unref();
    return { ok: true, pid: process.pid };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", { preHandler: requireToken }, async (req, reply) => {
    try { const j = cancelJob(db, req.params.id, actor); d.engine?.abortJob(req.params.id, "cancel"); return { ok: true, job: jobRow(j) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  app.post<{ Params: { id: string }; Body: { answer?: unknown } }>("/api/jobs/:id/answer", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, job: jobRow(answerJob(db, req.params.id, typeof req.body?.answer === "string" ? req.body.answer : "", actor)) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  /** A human gate: confirm (continue at the next stage) or ask for changes (the gated stage runs again with the note). */
  app.post<{ Params: { id: string } }>("/api/jobs/:id/gate/confirm", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, job: jobRow(confirmGate(db, req.params.id, actor, d.config?.factory.workflow?.planning_mode ?? "speckit")) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  app.post<{ Params: { id: string }; Body: { note?: unknown } }>("/api/jobs/:id/gate/return", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, job: jobRow(returnGate(db, req.params.id, typeof req.body?.note === "string" ? req.body.note : "", actor)) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  /** Approve or deny one thing an agent asked for. Deciding the last open one resumes a job that was waiting for them. */
  app.post<{ Params: { id: string; rid: string }; Body: { decision?: unknown } }>("/api/jobs/:id/permissions/:rid", { preHandler: requireToken }, async (req, reply) => {
    const decision = req.body?.decision;
    if (decision !== "approve" && decision !== "deny") return reply.code(400).send({ error: "decision must be approve or deny" });
    try { const r = decideRequest(db, req.params.id, Number(req.params.rid), decision, actor); return { ok: true, job: jobRow(r.job), resumed: r.resumed }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  /** "Request changes" on a job whose PR is open: queued, then applied by a fix pass and pushed to the same PR. */
  app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/api/jobs/:id/feedback", { preHandler: requireToken }, async (req, reply) => {
    try { const r = requestChanges(db, req.params.id, typeof req.body?.text === "string" ? req.body.text : "", actor); return { ok: true, job: jobRow(r.job), feedbackId: r.feedback.id }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  for (const [name, archived] of [["archive", true], ["unarchive", false]] as const) {
    app.post<{ Params: { id: string } }>(`/api/jobs/:id/${name}`, { preHandler: requireToken }, async (req, reply) => {
      try { return { ok: true, job: jobRow(archiveJob(db, req.params.id, actor, archived)) }; }
      catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
    });
  }
  /**
   * Delete a finished job. `?removeWorktree=1` also removes its worktree and local branch first (a job whose worktree is still on disk
   * cannot be deleted otherwise). A worktree with uncommitted changes is refused with code `worktree-dirty` until the caller repeats the
   * request with `&discardChanges=1`, so unsaved work is only ever thrown away deliberately.
   */
  app.delete<{ Params: { id: string }; Querystring: { removeWorktree?: string; discardChanges?: string } }>("/api/jobs/:id", { preHandler: requireToken }, async (req, reply) => {
    try {
      const job = getJob(db, req.params.id);
      if (!job) throw new JobError(`no such job ${req.params.id}`);
      if (req.query.removeWorktree === "1" && ["done", "failed", "cancelled"].includes(job.status)) {
        if (!d.worktrees) throw new JobError("this service cannot remove worktrees");
        const wt = db.select().from(worktrees).where(eq(worktrees.jobId, job.id)).get();
        if (wt && wt.state !== "removed") {
          const discardChanges = req.query.discardChanges === "1";
          // A pushed branch (a PR was raised) loses nothing when the local copy goes; otherwise only delete it if git says it is merged, or the human said to discard.
          try { await d.worktrees.remove(job.id, { deleteBranch: discardChanges || job.prUrl ? "force" : "safe", discardChanges }); }
          catch (e) {
            if (e instanceof WorktreeError && e.code === "dirty") return reply.code(409).send({ error: e.message.replace(/; preserved$/, ""), code: "worktree-dirty" });
            throw new JobError(`could not remove the worktree: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      const { logPaths } = deleteJob(db, req.params.id);
      if (d.dataDir) for (const p of logPaths) removeLog(d.dataDir, p);
      return { ok: true };
    } catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, job: jobRow(retryJob(db, req.params.id, actor)) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  if (d.settings && d.config) registerBoardRoutes(app, { db, config: d.config, linear: d.settings.linear }, requireToken);
  if (d.bitbucket && d.config) registerBitbucketRoutes(app, { ...d.bitbucket, config: d.config }, requireToken);
  if (d.config) registerTrackersRoutes(app, { db, config: d.config }, requireToken);
  if (d.config) registerGithubIssuesRoutes(app, { config: d.config, gh: d.githubIssues?.gh }, requireToken);
  if (d.jira && d.config) registerJiraRoutes(app, { ...d.jira, db, config: d.config }, requireToken);
  if (d.profiles) registerProfileRoutes(app, d.profiles, requireToken);
  registerChatRoutes(app, { db, dataDir: d.dataDir, chat: d.chat }, requireToken);
  if (d.settings && d.config) registerSettingsRoutes(app, { ...d.settings, db, config: d.config }, requireToken);
}
