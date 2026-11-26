import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, pendingMigrations } from "../src/migrate.js";
import { pgliteDb } from "./helpers.js";

describe("migrations", () => {
  it("applies once, is repeatable, and records versions", async () => {
    const db = pgliteDb();
    expect(await pendingMigrations(db)).toEqual(["0001", "0002", "0003"]);
    expect(await migrate(db)).toEqual(["0001", "0002", "0003"]);
    expect(await migrate(db)).toEqual([]); // re-running a deployment workflow is a no-op
    expect(await pendingMigrations(db)).toEqual([]);
  });

  it("creates every durable table the hub needs", async () => {
    const db = pgliteDb(); await migrate(db);
    const t = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name);
    for (const n of ["users", "passkey_credentials", "sessions", "organisations", "memberships", "factories", "factory_credentials", "factory_permissions", "projects", "jobs", "workflows", "factory_events", "remote_commands", "outbox", "audit_events", "push_subscriptions", "notification_preferences", "notification_deliveries", "webauthn_challenges"])
      expect(t).toContain(n);
  });

  it("refuses to run when an applied migration was edited", async () => {
    const db = pgliteDb(); const ms = loadMigrations(); await migrate(db, ms);
    await expect(migrate(db, [{ ...ms[0]!, sql: ms[0]!.sql + "\n-- edited", checksum: "different" }])).rejects.toThrow(/modified after being applied/);
  });

  it("preserves existing data when later migrations are applied", async () => {
    const db = pgliteDb(); const [m1] = loadMigrations(); await migrate(db, [m1!]);
    await db.query("INSERT INTO organisations (slug, name) VALUES ('keep','Keep me')");
    await migrate(db, [m1!, { version: "0002", name: "add_col", sql: "ALTER TABLE organisations ADD COLUMN note text;", checksum: "x" }]);
    expect((await db.query<{ name: string }>("SELECT name FROM organisations")).rows[0]!.name).toBe("Keep me");
  });
});
