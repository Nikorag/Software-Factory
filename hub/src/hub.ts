import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { CommandService } from "./commands.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { HubState } from "./health.js";
import type { Bus, DispatchQueue, RateLimiter } from "./infra.js";
import { pendingMigrations } from "./migrate.js";
import { buildServer } from "./server.js";

export interface Infra { db: Db; bus: Bus; queue: DispatchQueue; limiter: RateLimiter }

/** Composition root: wires services, background loops and shutdown. Infra is injected (tests use fakes). */
export function createHub(cfg: Config, infra: Infra, log: Logger) {
  const state: HubState = { shuttingDown: false, initialised: false };
  const commands = new CommandService(cfg, infra.db, infra.queue, infra.bus, log);
  const app: FastifyInstance = buildServer({ cfg, ...infra, log, commands, state });
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const loop = (name: string, ms: number, fn: () => Promise<unknown>) => {
    let running = false;
    timers.push(setInterval(() => {
      if (running || stopped) return;
      running = true;
      fn().catch((e) => log.warn({ loop: name, err: (e as Error).message }, "background task failed")).finally(() => { running = false; });
    }, ms).unref());
  };

  // Never run migrations here: that is the migration Job's responsibility (no replica races). We only
  // verify the schema is current and keep trying until it is, so a pod started before the Job finished
  // simply stays "starting" instead of crash-looping.
  async function initialise(): Promise<void> {
    for (let attempt = 0; !stopped; attempt++) {
      try {
        await infra.bus.ping();
        const pending = await pendingMigrations(infra.db);
        if (pending.length) throw new Error(`database migrations pending: ${pending.join(", ")} (run the migrate Job)`);
        break;
      } catch (e) {
        log.warn({ err: (e as Error).message, attempt }, "waiting for dependencies");
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
      }
    }
    if (stopped) return;
    if (cfg.RUN_BACKGROUND) {
      infra.queue.startWorker((id) => commands.onDispatch(id));
      loop("outbox", cfg.OUTBOX_INTERVAL_MS, () => commands.relayOutbox());
      loop("reconcile", cfg.RECONCILE_INTERVAL_MS, async () => {
        const r = await commands.reconcile();
        if (r.expired || r.unknown || r.requeued || r.failed || r.reenqueued) log.info(r, "reconciled commands");
      });
    }
    state.initialised = true;
    log.info("hub initialised");
  }

  return {
    app, state, commands,
    async start(): Promise<void> {
      await app.listen({ port: cfg.PORT, host: cfg.HOST });
      void initialise();
    },
    async shutdown(): Promise<void> {
      if (stopped) return;
      state.shuttingDown = true; // readiness -> 503 so the endpoint is removed from the Service
      log.info({ drainMs: cfg.SHUTDOWN_DRAIN_MS }, "shutdown: draining");
      await new Promise((r) => setTimeout(r, cfg.SHUTDOWN_DRAIN_MS));
      stopped = true;
      timers.forEach(clearInterval);
      await app.close(); // finishes in-flight requests; long-polls/SSE are released by the onClose hook
      await infra.queue.close(); // waits for the active job
      await infra.limiter.close();
      await infra.bus.close();
      await infra.db.close();
      log.info("shutdown: complete");
    },
  };
}
