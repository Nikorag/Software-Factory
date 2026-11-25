import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { jobs, projects, stageExecutions, factoryState } from "../src/db/schema.js";

const job = (id: string, status: "queued" | "done" = "queued") =>
  ({ id, projectId: "p", externalId: "lin-1", externalKey: "ENG-1", status }) as const;

describe("database", () => {
  it("migrates and seeds the control row with safe defaults", () => {
    const { db } = openDb(":memory:");
    const s = db.select().from(factoryState).get();
    expect(s).toMatchObject({ id: 1, paused: false, emergencyStop: false });
  });
  it("prevents two active jobs for the same issue but allows re-queue after completion", () => {
    const { db } = openDb(":memory:");
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    db.insert(jobs).values(job("j1")).run();
    expect(() => db.insert(jobs).values(job("j2")).run()).toThrow(/UNIQUE/);
    db.update(jobs).set({ status: "done" }).run();
    expect(() => db.insert(jobs).values(job("j3")).run()).not.toThrow();
  });
  it("rejects duplicate stage execution records (idempotency key)", () => {
    const { db } = openDb(":memory:");
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    db.insert(jobs).values(job("j1")).run();
    const row = { jobId: "j1", stage: "DISCOVERED", attempt: 1, outcome: "started", idempotencyKey: "j1:DISCOVERED:1" } as const;
    db.insert(stageExecutions).values(row).run();
    expect(() => db.insert(stageExecutions).values(row).run()).toThrow(/UNIQUE/);
  });
  it("enforces foreign keys", () => {
    const { db } = openDb(":memory:");
    expect(() => db.insert(jobs).values(job("j1")).run()).toThrow(/FOREIGN KEY/);
  });
});
