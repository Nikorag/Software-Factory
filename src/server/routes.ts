import { realpathSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { LoadedConfig } from "../config/schema.js";
import { STAGES } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, artifacts, decisions, jobs, linearOutbox, projects, stageExecutions, worktrees } from "../db/schema.js";
import * as control from "../core/control.js";
import type { Engine } from "../core/engine.js";
import { answerJob, cancelJob, JobError, retryJob } from "../core/jobs.js";
import type { Scheduler } from "../service/scheduler.js";
import { counts, systemInfo, type HealthChecker } from "../service/metrics.js";
import { readConversation } from "../agents/transcript.js";
import { registerSettingsRoutes } from "./settings-routes.js";

export interface ApiDeps {
  db: FactoryDb;
  logger: Logger;
  config?: LoadedConfig;
  engine?: Engine;
  scheduler?: Scheduler;
  health?: HealthChecker;
  dataDir?: string;
  /** Settings UI + setup wizard. Absent in tests that do not exercise them. */
  updates?: { status(): Promise<import("../service/versions.js").UpdateStatus> };
  settings?: Omit<import("./settings-routes.js").SettingsDeps, "db" | "config">;
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const jobRow = (j: typeof jobs.$inferSelect) => ({
  id: j.id, key: j.externalKey, project: j.projectId, workflow: j.workflow, stage: j.stage, status: j.status, heldFromStage: j.heldFromStage,
  remediationAttempts: j.remediationAttempts, stageAttempts: j.stageAttempts, autonomous: j.autonomous, dryRun: j.dryRun, prUrl: j.prUrl,
  lastError: j.lastError, notBefore: ms(j.notBefore), createdAt: ms(j.createdAt), updatedAt: ms(j.updatedAt),
});
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

export function registerApiRoutes(app: FastifyInstance, d: ApiDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const { db } = d;
  const actor = "dashboard";

  app.get("/api/overview", async () => {
    const all = db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(300).all();
    return {
      control: control.getControl(db),
      counts: counts(db),
      active: all.filter((j) => j.status === "running").map(jobRow),
      queued: all.filter((j) => j.status === "queued" || j.status === "waiting").slice(0, 30).map(jobRow),
      recent: all.filter((j) => ["done", "failed", "cancelled"].includes(j.status)).slice(0, 20).map(jobRow),
      engineActive: d.engine?.activeJobIds() ?? [],
      scheduler: d.scheduler?.status() ?? null,
      system: await systemInfo(d.dataDir ?? "."),
      health: (await d.health?.check()) ?? [],
      projectCount: d.config?.projects.projects.length,
      mergeMode: d.config?.factory.mergeMode ?? "pr-only",
      dryRun: d.config?.factory.dryRun ?? false,
    };
  });

  app.get<{ Querystring: { status?: string; project?: string; limit?: string } }>("/api/jobs", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    let rows = db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(1000).all();
    if (req.query.status) rows = rows.filter((j) => j.status === req.query.status);
    if (req.query.project) rows = rows.filter((j) => j.projectId === req.query.project);
    return { jobs: rows.slice(0, limit).map(jobRow) };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = db.select().from(jobs).where(eq(jobs.id, req.params.id)).get();
    if (!job) return reply.code(404).send({ error: "no such job" });
    const id = job.id;
    return {
      job: jobRow(job),
      remediationCap: d.engine?.remediationCap(job) ?? d.config?.projects.projects.find((p) => p.id === job.projectId)?.overrides?.maxRemediationAttempts ?? d.config?.factory.maxRemediationAttempts ?? 3,
      stageOrder: STAGES,
      executions: db.select().from(stageExecutions).where(eq(stageExecutions.jobId, id)).orderBy(asc(stageExecutions.id)).all()
        .map((e) => ({ id: e.id, stage: e.stage, attempt: e.attempt, outcome: e.outcome, error: clip(e.error), output: clip(e.outputJson, 1500), startedAt: ms(e.startedAt), finishedAt: ms(e.finishedAt) })),
      decisions: db.select().from(decisions).where(eq(decisions.jobId, id)).orderBy(asc(decisions.id)).all()
        .map((x) => ({ id: x.id, kind: x.kind, decision: clip(x.decision, 500), rationale: clip(x.rationale, 1500), actor: x.actor, at: ms(x.createdAt) })),
      invocations: db.select().from(agentInvocations).where(eq(agentInvocations.jobId, id)).orderBy(asc(agentInvocations.id)).all()
        .map((a) => ({ id: a.id, stageExecutionId: a.stageExecutionId, agent: a.agent, model: a.model, exitCode: a.exitCode, durationMs: a.durationMs, usage: a.usageJson ? JSON.parse(a.usageJson) : null, hasLog: Boolean(a.logPath), at: ms(a.startedAt) })),
      artifacts: db.select().from(artifacts).where(eq(artifacts.jobId, id)).orderBy(asc(artifacts.id)).all().filter((a) => !a.kind.startsWith("step:"))
        .map((a) => ({ kind: a.kind, path: a.path, bytes: a.bytes, at: ms(a.createdAt) })),
      worktree: db.select().from(worktrees).where(eq(worktrees.jobId, id)).get() ?? null,
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
    return { ...out, done: inv.exitCode !== null, agent: inv.agent, model: inv.model };
  });

  app.get("/api/projects", async () => {
    const rows = db.select().from(projects).all();
    return {
      projects: (d.config?.projects.projects ?? []).map((p) => {
        const row = rows.find((r) => r.id === p.id);
        const report = row?.validationJson ? (JSON.parse(row.validationJson) as { ok?: boolean; findings?: { severity: string; code: string; message: string }[]; branchProtection?: { status: string } }) : null;
        return {
          id: p.id, name: p.name, enabled: p.enabled, autonomy: p.autonomy, repository: p.repository, managed: p.managed, defaultBranch: p.defaultBranch, githubAccount: p.github.account ?? null, overrides: p.overrides ?? null,
          linear: p.linear ?? null, githubRepo: p.github.repo ?? null, commands: p.commands,
          validation: report ? { ok: report.ok ?? false, at: ms(row?.lastValidatedAt), protection: report.branchProtection?.status ?? "unknown", findings: (report.findings ?? []).filter((f) => f.severity !== "info").map((f) => `${f.severity}: ${f.message}`) } : null,
          activeJobs: db.select().from(jobs).where(and(eq(jobs.projectId, p.id), inArray(jobs.status, ["queued", "running", "waiting"]))).all().length,
        };
      }),
    };
  });

  app.get("/api/update", async () => (await d.updates?.status()) ?? { current: null, latest: null, available: false, checkedAt: null });

  app.get("/api/health", async () => ({ system: await systemInfo(d.dataDir ?? "."), health: (await d.health?.check()) ?? [], scheduler: d.scheduler?.status() ?? null }));

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

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", { preHandler: requireToken }, async (req, reply) => {
    try { const j = cancelJob(db, req.params.id, actor); d.engine?.abortJob(req.params.id, "cancel"); return { ok: true, job: jobRow(j) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  app.post<{ Params: { id: string }; Body: { answer?: unknown } }>("/api/jobs/:id/answer", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, job: jobRow(answerJob(db, req.params.id, typeof req.body?.answer === "string" ? req.body.answer : "", actor)) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, job: jobRow(retryJob(db, req.params.id, actor)) }; }
    catch (e) { return reply.code(409).send({ error: e instanceof JobError ? e.message : "failed" }); }
  });
  if (d.settings && d.config) registerSettingsRoutes(app, { ...d.settings, db, config: d.config }, requireToken);
}
