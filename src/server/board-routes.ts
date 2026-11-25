import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { pickupModeOf, type LoadedConfig, type ProjectConfig } from "../config/schema.js";
import { enqueue } from "../core/jobs.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs } from "../db/schema.js";
import type { LinearClient, LinearIssue } from "../linear/client.js";
import { evaluateEligibility } from "../linear/eligibility.js";
import { enqueueOutbox } from "../linear/outbox.js";
import { isRunnable, onboardingFor } from "../repo/registry.js";

export interface BoardDeps { db: FactoryDb; config: LoadedConfig; linear: () => LinearClient }
const ACTIVE = ["queued", "running", "waiting"] as const;
const RANK: Record<string, number> = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4, canceled: 5 };

/** What the search box means: "418" (a number), "JAM-418" (a ticket key), or words (a title). */
export function parseSearch(raw: string): { number?: number; teamKey?: string; title?: string } | null {
  const q = raw.trim();
  if (!q) return null;
  if (/^#?\d{1,9}$/.test(q)) return { number: Number(q.replace("#", "")) };
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d{1,9})$/.exec(q);
  if (m) return { teamKey: m[1]!.toUpperCase(), number: Number(m[2]) };
  return { title: q.slice(0, 100) };
}

/** Which of our projects a Linear ticket belongs to (the most specific binding wins; a whole-team binding is the fallback). */
export function projectFor(issue: LinearIssue, projects: ProjectConfig[]): ProjectConfig | null {
  const mine = projects.filter((p) => p.linear?.teamKey === issue.team.key);
  const inProjects = issue.projects?.length ? issue.projects : issue.project ? [issue.project] : [];
  return mine.find((p) => inProjects.some((x) => (p.linear!.projectId && p.linear!.projectId === x.id) || (p.linear!.projectName && p.linear!.projectName === x.name)))
    ?? mine.find((p) => !p.linear!.projectId && !p.linear!.projectName) ?? null;
}

export function registerBoardRoutes(app: FastifyInstance, d: BoardDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const bound = () => d.config.projects.projects.filter((p) => p.enabled && p.linear);

  /** Open tickets of every bound project (or one), or a search by number / key / title. Read-only; each ticket says whether it can be started and why not. */
  app.get<{ Querystring: { project?: string; q?: string } }>("/api/board", async (req, reply) => {
    const search = parseSearch(req.query.q ?? "");
    const wanted = bound().filter((p) => !req.query.project || p.id === req.query.project);
    if (req.query.project && wanted.length === 0) return reply.code(404).send({ error: `no such project: ${req.query.project}` });
    const issues: LinearIssue[] = [];
    try {
      const client = d.linear();
      const seen = new Set<string>();
      // One query per team (a number or key is searched across the team, then mapped to a project), one per project for the open-ticket board.
      const asks = search
        ? [...new Set(wanted.map((p) => p.linear!.teamKey))].filter((t) => !search.teamKey || t === search.teamKey).map((t) => ({ teamKey: t, number: search.number, title: search.title, limit: 25 }))
        : wanted.map((p) => ({ teamKey: p.linear!.teamKey, projectId: p.linear!.projectId, projectName: p.linear!.projectName, openOnly: true, limit: 100 }));
      for (const r of await Promise.all(asks.map((a) => client.boardIssues(a)))) for (const i of r) if (!seen.has(i.id)) { seen.add(i.id); issues.push(i); }
    } catch (e) { return reply.code(502).send({ error: `Linear: ${(e as Error).message}` }); }

    const latest = new Map<string, { id: string; status: string; stage: string }>();
    if (issues.length) for (const j of d.db.select().from(jobs).where(inArray(jobs.externalId, issues.map((i) => i.id))).orderBy(desc(jobs.createdAt)).all()) if (!latest.has(j.externalId)) latest.set(j.externalId, { id: j.id, status: j.status, stage: j.stage });

    const items = issues.flatMap((i) => {
      const p = projectFor(i, wanted.length ? wanted : bound());
      if (!p) return []; // not one of this profile's projects
      const job = latest.get(i.id) ?? null;
      let reason: string | null = null;
      if (["completed", "canceled"].includes(i.state.type)) reason = `already ${i.state.name}`;
      else if (job && (ACTIVE as readonly string[]).includes(job.status)) reason = "the factory is already working on it";
      else if (!isRunnable(d.db, p.id)) reason = "the project has not passed validation (Settings → Projects → Validate)";
      else if (onboardingFor(d.db, p).status !== "ready") reason = "the project is not onboarded yet (Settings → Projects)";
      return [{ id: i.id, key: i.identifier, title: i.title, url: i.url, state: i.state.name, stateType: i.state.type, labels: i.labels.map((l) => l.name), linearProject: i.project?.name ?? null,
        projectId: p.id, projectName: p.name, mode: pickupModeOf(p, d.config.factory), job, canStart: reason === null, reason }];
    });
    items.sort((a, b) => (RANK[a.stateType] ?? 9) - (RANK[b.stateType] ?? 9) || a.state.localeCompare(b.state) || a.key.localeCompare(b.key, undefined, { numeric: true }));
    return { mode: d.config.factory.pickupMode, query: req.query.q ?? "", items, projects: bound().map((p) => ({ id: p.id, name: p.name, mode: pickupModeOf(p, d.config.factory) })) };
  });

  /** Start work on one ticket. Your choosing it is the opt-in, so no label or status is needed; the project must still be onboarded. */
  app.post<{ Body: { issueId?: unknown } }>("/api/board/start", { preHandler: requireToken }, async (req, reply) => {
    const id = typeof req.body?.issueId === "string" ? req.body.issueId : "";
    if (!id) return reply.code(400).send({ error: "issueId is required" });
    let issue: LinearIssue;
    try { issue = await d.linear().getIssue(id); } catch (e) { return reply.code(404).send({ error: `cannot read that ticket from Linear: ${(e as Error).message}` }); }
    const project = projectFor(issue, bound());
    if (!project) return reply.code(409).send({ error: `${issue.identifier} does not belong to any project of this profile` });
    const prior = d.db.select().from(jobs).where(and(eq(jobs.projectId, project.id), eq(jobs.externalId, issue.id))).orderBy(desc(jobs.createdAt)).limit(1).get();
    const v = evaluateEligibility(issue, project, d.config.linear, { projectRunnable: isRunnable(d.db, project.id), existingJobStatus: prior?.status, manual: true });
    if (!v.eligible) return reply.code(409).send({ error: `${issue.identifier}: ${v.reasons.join("; ")}` });
    const ob = onboardingFor(d.db, project);
    if (ob.status !== "ready") return reply.code(409).send({ error: `${project.name} is not onboarded yet (still to do: ${ob.steps.filter((s) => !s.ok).map((s) => s.label.toLowerCase()).join("; ")})` });
    const { job, created } = enqueue(d.db, { projectId: project.id, externalId: issue.id, externalKey: issue.identifier, workflow: v.workflow, autonomous: v.autonomous, dryRun: d.config.factory.dryRun, manual: true });
    if (!created) return reply.code(409).send({ error: `${issue.identifier} already has an active job` });
    d.db.insert(decisions).values({ jobId: job.id, kind: "manual.start", decision: `started ${issue.identifier} from the board as ${v.workflow}`, rationale: issue.url, actor: "dashboard" }).run();
    if (!d.config.factory.dryRun) enqueueOutbox(d.db, job.id, issue.id, { kind: "comment", body: `**Software factory** was asked to work on this ticket (\`${v.workflow}\`).` }, `${job.id}:pickup`);
    return { ok: true, jobId: job.id };
  });
}
