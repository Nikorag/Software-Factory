import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

// Forward-only, versioned SQL migrations. Applied by `hub migrate` (a Kubernetes Job), never by
// serving replicas. A transaction-scoped advisory lock serialises concurrent runners, so even an
// accidental double run cannot race. Each file's checksum is recorded; an applied file that was
// edited afterwards fails loudly instead of silently diverging.
const LOCK_KEY = 7_352_901; // arbitrary constant, unique to this app

export interface Migration { version: string; name: string; sql: string; checksum: string }

export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> ../migrations ; dist/ -> ./migrations (copied at build)
  for (const c of [join(here, "migrations"), join(here, "..", "migrations")]) {
    try { readdirSync(c); return c; } catch { /* try next */ }
  }
  throw new Error("migrations directory not found");
}

export function loadMigrations(dir = migrationsDir()): Migration[] {
  return readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => {
    const sql = readFileSync(join(dir, f), "utf8");
    return { version: f.slice(0, 4), name: f.slice(5, -4), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;

export async function migrate(db: Db, migrations = loadMigrations(), log: (m: string) => void = () => undefined): Promise<string[]> {
  const applied: string[] = [];
  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await q.exec(BOOTSTRAP);
    const done = new Map((await q.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.checksum) throw new Error(`Migration ${m.version}_${m.name} was modified after being applied; write a new migration instead`);
        continue;
      }
      log(`applying ${m.version}_${m.name}`);
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)", [m.version, m.name, m.checksum]);
      applied.push(m.version);
    }
  });
  return applied;
}

/** Migrations known to the code but not yet applied (empty = schema current). */
export async function pendingMigrations(db: Db, migrations = loadMigrations()): Promise<string[]> {
  let done = new Set<string>();
  try { done = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version)); }
  catch { /* table absent: nothing applied */ }
  return migrations.filter((m) => !done.has(m.version)).map((m) => m.version);
}
