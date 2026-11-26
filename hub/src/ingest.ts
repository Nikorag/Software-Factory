import { z } from "zod";
import type { Db } from "./db.js";
import { channels, type Bus } from "./infra.js";

export const eventsBody = z.object({
  events: z.array(z.object({
    id: z.string().min(1).max(200), type: z.string().min(1).max(100),
    jobId: z.string().max(200).optional(), occurredAt: z.coerce.date(), payload: z.record(z.string(), z.unknown()).default({}),
  })).min(1).max(500),
});

export const syncBody = z.object({
  projects: z.array(z.object({ id: z.string().max(200), name: z.string().max(300), metadata: z.record(z.string(), z.unknown()).default({}) })).max(500).default([]),
  jobs: z.array(z.object({ id: z.string().max(200), projectId: z.string().max(200).optional(), title: z.string().max(500).optional(),
    stage: z.string().max(100).optional(), status: z.string().max(100).optional(), workflowId: z.string().max(200).optional(), metadata: z.record(z.string(), z.unknown()).default({}) })).max(1000).default([]),
  workflows: z.array(z.object({ id: z.string().max(200), name: z.string().max(300), version: z.string().max(100).optional(), definition: z.record(z.string(), z.unknown()).default({}) })).max(200).default([]),
});

/** Idempotent: re-sending a batch inserts nothing new. Returns how many were new. */
export async function ingestEvents(db: Db, bus: Bus, factoryId: string, orgId: string, body: z.infer<typeof eventsBody>): Promise<number> {
  const fresh = await db.tx(async (q) => {
    const out: Array<{ id: number; type: string; jobId?: string }> = [];
    for (const e of body.events) {
      const job = e.jobId ? (await q.query<{ id: string }>("SELECT id FROM jobs WHERE factory_id=$1 AND external_id=$2", [factoryId, e.jobId])).rows[0] : undefined;
      const r = await q.query<{ id: number }>(
        `INSERT INTO factory_events (factory_id, event_id, job_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (factory_id, event_id) DO NOTHING RETURNING id`,
        [factoryId, e.id, job?.id ?? null, e.type, JSON.stringify(e.payload), e.occurredAt]);
      if (r.rows[0]) out.push({ id: Number(r.rows[0].id), type: e.type, jobId: e.jobId });
    }
    return out;
  });
  // Live dashboard fan-out is best effort; the durable record is already committed.
  if (fresh.length) await bus.publish(channels.org(orgId), JSON.stringify({ factoryId, events: fresh })).catch(() => undefined);
  return fresh.length;
}

export async function syncMetadata(db: Db, factoryId: string, body: z.infer<typeof syncBody>): Promise<void> {
  await db.tx(async (q) => {
    for (const p of body.projects) {
      await q.query(`INSERT INTO projects (factory_id, external_id, name, metadata) VALUES ($1,$2,$3,$4)
        ON CONFLICT (factory_id, external_id) DO UPDATE SET name=EXCLUDED.name, metadata=EXCLUDED.metadata, updated_at=now()`, [factoryId, p.id, p.name, JSON.stringify(p.metadata)]);
    }
    for (const j of body.jobs) {
      const proj = j.projectId ? (await q.query<{ id: string }>("SELECT id FROM projects WHERE factory_id=$1 AND external_id=$2", [factoryId, j.projectId])).rows[0] : undefined;
      await q.query(`INSERT INTO jobs (factory_id, project_id, external_id, title, stage, status, workflow_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (factory_id, external_id) DO UPDATE SET project_id=EXCLUDED.project_id, title=EXCLUDED.title, stage=EXCLUDED.stage,
          status=EXCLUDED.status, workflow_id=EXCLUDED.workflow_id, metadata=EXCLUDED.metadata, updated_at=now()`,
        [factoryId, proj?.id ?? null, j.id, j.title ?? null, j.stage ?? null, j.status ?? null, j.workflowId ?? null, JSON.stringify(j.metadata)]);
    }
    for (const w of body.workflows) {
      await q.query(`INSERT INTO workflows (factory_id, external_id, name, version, definition) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (factory_id, external_id) DO UPDATE SET name=EXCLUDED.name, version=EXCLUDED.version, definition=EXCLUDED.definition, updated_at=now()`,
        [factoryId, w.id, w.name, w.version ?? null, JSON.stringify(w.definition)]);
    }
  });
}
