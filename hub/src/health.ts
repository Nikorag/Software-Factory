import type { Db } from "./db.js";
import type { Bus } from "./infra.js";
import { pendingMigrations } from "./migrate.js";

export interface HubState { shuttingDown: boolean; initialised: boolean }

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref())]);

export interface Readiness { ready: boolean; checks: Record<string, "ok" | string> }

/**
 * Readiness answers "should this pod receive traffic right now?": process accepting requests AND
 * PostgreSQL + Redis reachable AND schema current. Failing it only removes the pod from the Service.
 * Liveness (see server.ts) deliberately checks none of this, so a database or Redis outage never
 * causes restarts, which would only add load and lose nothing useful.
 */
export function makeReadiness(db: Db, bus: Bus, state: HubState, cacheMs = 1000) {
  let cached: { at: number; value: Readiness } | undefined;
  return async (): Promise<Readiness> => {
    if (state.shuttingDown) return { ready: false, checks: { lifecycle: "shutting down" } };
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    const checks: Record<string, string> = {};
    const run = async (name: string, fn: () => Promise<unknown>) => { try { await withTimeout(fn(), 2000); checks[name] = "ok"; } catch (e) { checks[name] = (e as Error).message; } };
    await Promise.all([
      run("postgres", () => db.query("SELECT 1")),
      run("redis", () => bus.ping()),
    ]);
    if (checks.postgres === "ok") await run("migrations", async () => { const p = await pendingMigrations(db); if (p.length) throw new Error(`pending: ${p.join(",")}`); });
    else checks.migrations = "skipped";
    const value = { ready: state.initialised && Object.values(checks).every((v) => v === "ok"), checks };
    cached = { at: Date.now(), value };
    return value;
  };
}
