import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { factoryState } from "../db/schema.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function buildServer(deps: { db: FactoryDb; logger: Logger }): FastifyInstance {
  const app: FastifyInstance = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger });

  // Defence in depth: refuse any non-loopback peer even if the bind address is changed.
  app.addHook("onRequest", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: "loopback only" });
  });

  app.get("/health", async () => {
    const state = deps.db.select().from(factoryState).where(eq(factoryState.id, 1)).get();
    return { status: "ok", paused: state?.paused ?? false, emergencyStop: state?.emergencyStop ?? false };
  });
  return app;
}
