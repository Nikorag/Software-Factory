import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, inArray } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, LESSON_KINDS, LESSON_STATUSES, lessons, projects, type LessonKind, type LessonStatus } from "../db/schema.js";
import { approveLesson, editLesson, LessonError, lessonKind, listLessons, proposeLesson, rejectLesson, retireLesson, type LessonRow } from "../lessons/store.js";

export interface LessonsRouteDeps { db: FactoryDb }

const actor = "dashboard";
const view = (l: LessonRow) => ({ id: l.id, projectId: l.projectId, text: l.text, kind: l.kind, status: l.status, source: l.source, sourceJobId: l.sourceJobId, hits: l.hits, createdAt: l.createdAt.getTime(), lastUsedAt: l.lastUsedAt?.getTime() ?? null });

/** The lessons injected into any invocation of a job (ids are kept in each invocation's usage JSON), for the job page. */
export function injectedLessons(db: FactoryDb, jobId: string): { id: number; kind: LessonKind; text: string; status: LessonStatus }[] {
  const ids = new Set<number>();
  for (const r of db.select({ u: agentInvocations.usageJson }).from(agentInvocations).where(eq(agentInvocations.jobId, jobId)).all()) {
    try {
      const l = r.u ? (JSON.parse(r.u) as { lessons?: unknown }).lessons : undefined;
      if (Array.isArray(l)) for (const x of l) if (typeof x === "number") ids.add(x);
    } catch { /* malformed usage: skip */ }
  }
  if (ids.size === 0) return [];
  return db.select().from(lessons).where(inArray(lessons.id, [...ids])).all().map((l) => ({ id: l.id, kind: l.kind, text: l.text, status: l.status }));
}

/**
 * Per-project lessons (ADR 0017). Reads are open like the other dashboard reads; every change needs the token and is recorded
 * as a decision by the store. Creating always yields a `proposed` lesson: only Approve makes one active.
 */
export function registerLessonsRoutes(app: FastifyInstance, d: LessonsRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof LessonError) return reply.code(/no such lesson/.test(e.message) ? 404 : /^(kind|nothing|the )/.test(e.message) ? 400 : 409).send({ error: e.message });
    throw e;
  };
  const idOf = (raw: string): number | undefined => (/^\d{1,9}$/.test(raw) ? Number(raw) : undefined);
  const badId = (reply: FastifyReply) => reply.code(400).send({ error: "invalid lesson id" });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/projects/:id/lessons", async (req, reply) => {
    const status = req.query.status;
    if (status !== undefined && !(LESSON_STATUSES as readonly string[]).includes(status)) return reply.code(400).send({ error: `status must be one of: ${LESSON_STATUSES.join(", ")}` });
    if (!d.db.select().from(projects).where(eq(projects.id, req.params.id)).get()) return reply.code(404).send({ error: "no such project" });
    return { lessons: listLessons(d.db, req.params.id, status as LessonStatus | undefined).map(view) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/lessons", { preHandler: requireToken }, async (req, reply) => {
    const b = (req.body ?? {}) as { text?: unknown; kind?: unknown };
    if (typeof b.text !== "string") return reply.code(400).send({ error: "text is required" });
    if (typeof b.kind !== "string" || !(LESSON_KINDS as readonly string[]).includes(b.kind)) return reply.code(400).send({ error: `kind must be one of: ${LESSON_KINDS.join(", ")}` });
    if (!d.db.select().from(projects).where(eq(projects.id, req.params.id)).get()) return reply.code(404).send({ error: "no such project" });
    const r = proposeLesson(d.db, { projectId: req.params.id, text: b.text, kind: b.kind as LessonKind, source: "human", actor, clip: false });
    if ("refused" in r) return reply.code(400).send({ error: `lesson not stored: ${r.refused}` });
    return { ok: true, lesson: view(r.lesson) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/lessons/:id", { preHandler: requireToken }, async (req, reply) => {
    const id = idOf(req.params.id);
    if (id === undefined) return badId(reply);
    const b = (req.body ?? {}) as { text?: unknown; kind?: unknown };
    if (b.text !== undefined && typeof b.text !== "string") return reply.code(400).send({ error: "text must be a string" });
    try {
      return { ok: true, lesson: view(editLesson(d.db, id, { ...(b.text !== undefined ? { text: b.text as string } : {}), ...(b.kind !== undefined ? { kind: lessonKind(b.kind) } : {}) }, actor)) };
    } catch (e) { return fail(reply, e); }
  });

  const action = (name: "approve" | "reject" | "retire", run: (id: number) => LessonRow) =>
    app.post<{ Params: { id: string } }>(`/api/lessons/:id/${name}`, { preHandler: requireToken }, async (req, reply) => {
      const id = idOf(req.params.id);
      if (id === undefined) return badId(reply);
      try { return { ok: true, lesson: view(run(id)) }; } catch (e) { return fail(reply, e); }
    });
  action("approve", (id) => approveLesson(d.db, id, actor));
  action("reject", (id) => rejectLesson(d.db, id, actor));
  action("retire", (id) => retireLesson(d.db, id, actor));
}
