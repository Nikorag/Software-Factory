import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { jobs, projects } from "../src/db/schema.js";
import { answerJob, enqueue, getJob, humanAnswers, JobError } from "../src/core/jobs.js";
import { eq } from "drizzle-orm";

const held = (heldFrom: string) => {
  const { db } = openDb(":memory:");
  db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  const { job } = enqueue(db, { projectId: "p", externalId: "e1", externalKey: "JAM-1" });
  db.update(jobs).set({ stage: "BLOCKED", status: "waiting", heldFromStage: heldFrom }).where(eq(jobs.id, job.id)).run();
  return { db, id: job.id };
};

describe("human answers", () => {
  it("records the answer and resumes at the held stage", () => {
    const { db, id } = held("REQUIREMENTS_ANALYSIS");
    const j = answerJob(db, id, "  Use port 7777  ", "dashboard");
    expect(j.stage).toBe("REQUIREMENTS_ANALYSIS");
    expect(j.status).toBe("queued");
    expect(humanAnswers(db, id)).toEqual(["Use port 7777"]);
  });
  it("routes answers to spec open questions into remediation, not a re-validation that blocks again", () => {
    const { db, id } = held("SPECIFICATION_VALIDATION");
    expect(answerJob(db, id, "yes", "dashboard").stage).toBe("SPECIFICATION_REMEDIATION");
  });
  it("rejects empty answers and jobs that are not held", () => {
    const { db, id } = held("REQUIREMENTS_ANALYSIS");
    expect(() => answerJob(db, id, "   ", "x")).toThrow(JobError);
    answerJob(db, id, "ok", "x");
    expect(() => answerJob(db, id, "again", "x")).toThrow(JobError);
    expect(getJob(db, id)!.status).toBe("queued");
  });
});
