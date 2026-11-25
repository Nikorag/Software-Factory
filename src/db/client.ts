import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type FactoryDb = BetterSQLite3Database<typeof schema>;
export interface DbHandle { db: FactoryDb; raw: Database.Database; close(): void }

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openDb(file: string): DbHandle {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL"); // durable and crash-safe
  raw.pragma("synchronous = NORMAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  db.insert(schema.factoryState).values({ id: 1 }).onConflictDoNothing().run();
  return { db, raw, close: () => raw.close() };
}
