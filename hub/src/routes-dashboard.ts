import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { can, issueFactoryCredential } from "./auth.js";
import { audit } from "./commands.js";
import type { Deps } from "./server.js";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

// Read API for the dashboard. Every query is scoped to what the signed-in user may view.
export function registerDashboardRoutes(app: FastifyInstance, d: Deps, requireUser: Guard) {
  const { cfg, db } = d;
  const fid = (req: FastifyRequest) => z.uuid().parse((req.params as { id: string }).id);

  app.get("/v1/me", { preHandler: requireUser }, async (req) => {
    const u = (await db.query<{ id: string; email: string; display_name: string }>("SELECT id, email, display_name FROM users WHERE id=$1", [req.user!.userId])).rows[0]!;
    const orgs = (await db.query("SELECT o.id, o.name, m.role FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.user_id=$1 ORDER BY o.name", [u.id])).rows;
    return { userId: u.id, email: u.email, displayName: u.display_name, orgs, publicUrl: cfg.PUBLIC_URL };
  });

  app.get("/v1/factories", { preHandler: requireUser }, async (req) => {
    const rows = (await db.query(
      `SELECT f.id, f.org_id AS "orgId", f.name, f.status, f.version, f.last_seen_at AS "lastSeenAt", COALESCE((f.metadata->>'remoteAccess')::boolean, false) AS "remoteAccess",
              (SELECT count(*)::int FROM jobs j WHERE j.factory_id = f.id) AS "jobCount",
              (SELECT count(*)::int FROM jobs j WHERE j.factory_id = f.id AND j.status IS DISTINCT FROM 'done' AND j.status IS DISTINCT FROM 'failed' AND j.status IS DISTINCT FROM 'cancelled') AS "activeJobs"
         FROM factories f
        WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = f.org_id AND m.user_id = $1)
           OR EXISTS (SELECT 1 FROM factory_permissions p WHERE p.factory_id = f.id AND p.user_id = $1)
        ORDER BY f.name`, [req.user!.userId])).rows;
    return { factories: rows, serverTime: new Date().toISOString() };
  });

  app.get("/v1/factories/:id", { preHandler: requireUser }, async (req, reply) => {
    const id = fid(req);
    if (!(await can(db, req.user!.userId, id, "view"))) return reply.code(404).send({ error: "not_found" });
    const one = async (sql: string) => (await db.query(sql, [id])).rows;
    const [factory] = await one(`SELECT id, org_id AS "orgId", name, status, version, last_seen_at AS "lastSeenAt", COALESCE((metadata->>'remoteAccess')::boolean, false) AS "remoteAccess", created_at AS "createdAt" FROM factories WHERE id=$1`);
    return {
      factory, serverTime: new Date().toISOString(),
      projects: await one(`SELECT external_id AS id, name, updated_at AS "updatedAt" FROM projects WHERE factory_id=$1 ORDER BY name`),
      workflows: await one(`SELECT external_id AS id, name, version, updated_at AS "updatedAt" FROM workflows WHERE factory_id=$1 ORDER BY name`),
      jobs: await one(`SELECT j.external_id AS id, j.title, j.stage, j.status, p.name AS project, j.workflow_id AS "workflowId", j.updated_at AS "updatedAt"
                         FROM jobs j LEFT JOIN projects p ON p.id = j.project_id WHERE j.factory_id=$1 ORDER BY j.updated_at DESC LIMIT 100`),
      events: await one(`SELECT e.id, e.type, j.external_id AS "jobId", e.payload, e.occurred_at AS "occurredAt"
                           FROM factory_events e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.factory_id=$1 ORDER BY e.occurred_at DESC, e.id DESC LIMIT 50`),
    };
  });

  // Replace the factory's API key: revokes every existing key, returns the new one once.
  app.post("/v1/factories/:id/rotate-key", { preHandler: requireUser }, async (req, reply) => {
    const id = fid(req);
    if (!(await can(db, req.user!.userId, id, "manage"))) return reply.code(403).send({ error: "forbidden" });
    const out = await db.tx(async (q) => {
      const f = (await q.query<{ org_id: string }>("SELECT org_id FROM factories WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!f) return null;
      await q.query("UPDATE factory_credentials SET revoked_at = now() WHERE factory_id=$1 AND revoked_at IS NULL", [id]);
      const token = await issueFactoryCredential(cfg, q, id);
      await audit(q, f.org_id, "user", req.user!.userId, "factory.rotate_key", id, {});
      return token;
    });
    return out ? reply.header("cache-control", "no-store").send({ token: out }) : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/factories/:id/disable", { preHandler: requireUser }, async (req, reply) => {
    const id = fid(req);
    if (!(await can(db, req.user!.userId, id, "manage"))) return reply.code(403).send({ error: "forbidden" });
    await db.query("UPDATE factories SET status='disabled' WHERE id=$1", [id]);
    await db.query("UPDATE factory_credentials SET revoked_at = now() WHERE factory_id=$1 AND revoked_at IS NULL", [id]);
    return { ok: true };
  });
}
