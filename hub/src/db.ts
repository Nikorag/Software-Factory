import pg from "pg";
import type { Config } from "./config.js";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Multi-statement SQL with no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Run fn in a transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// pg returns bigint/numeric as strings by default; our ids that are bigserial are read as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPgDb(cfg: Config): Db {
  const ssl = cfg.DATABASE_SSL === "disable" ? undefined
    : { rejectUnauthorized: cfg.DATABASE_SSL === "verify-full", ca: cfg.DATABASE_SSL_CA };
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL, max: cfg.DATABASE_POOL_MAX, idleTimeoutMillis: cfg.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: cfg.DATABASE_CONNECT_TIMEOUT_MS, statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: "software-factory-hub", ssl,
  });
  // An idle client erroring (e.g. Postgres restart) must not crash the process.
  pool.on("error", () => { /* surfaced by the next query / readiness probe */ });
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await c.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) { await c.query(sql); },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
