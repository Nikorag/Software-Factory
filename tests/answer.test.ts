import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { jobs, projects } from "../src/db/schema.js";
import { answerJob, enqueue, getJob, humanAnswers, humanQAs, JobError } from "../src/core/jobs.js";
import { decisions } from "../src/db/schema.js";
import { withAnswers } from "../src/app/stage-kit.js";
import { eq } from "drizzle-orm";

const held = (heldFrom: string, lastError: string | null = null) => {
  const { db } = openDb(":memory:");
  db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  const { job } = enqueue(db, { projectId: "p", externalId: "e1", externalKey: "JAM-1" });
  db.update(jobs).set({ stage: "BLOCKED", status: "waiting", heldFromStage: heldFrom, lastError }).where(eq(jobs.id, job.id)).run();
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
  it("keeps the questions with the answer, labelled with the stage that asked, even though retry clears lastError", () => {
    const { db, id } = held("REQUIREMENTS_ANALYSIS", "The requirements need clarification before a specification can be written:\n1. Which port?\n\nAnswer on the job page (the job resumes with your answer), or answer in the ticket and then retry the job.");
    answerJob(db, id, "Use port 7777", "dashboard");
    expect(getJob(db, id)!.lastError).toBeNull();
    expect(humanQAs(db, id)).toEqual([{ stage: "REQUIREMENTS_ANALYSIS", questions: "The requirements need clarification before a specification can be written:\n1. Which port?", answer: "Use port 7777" }]);
    expect(humanAnswers(db, id)).toEqual(["Use port 7777"]);
  });
  it("reads answers recorded before questions were kept (answer only)", () => {
    const { db, id } = held("REQUIREMENTS_ANALYSIS");
    db.insert(decisions).values({ jobId: id, kind: "human.answer", decision: "answered while held at REQUIREMENTS_ANALYSIS", rationale: "yes", actor: "x" }).run();
    expect(humanQAs(db, id)).toEqual([{ stage: "REQUIREMENTS_ANALYSIS", questions: "", answer: "yes" }]);
  });
  it("renders question -> answer pairs for agents that never saw the question", () => {
    const text = withAnswers("<ticket/>", [{ stage: "SPECIFICATION_VALIDATION", questions: "1. Should overdue items notify the owner?", answer: "yes" }, { stage: "", questions: "", answer: "old" }]);
    expect(text).toContain("Answer 1 (to questions asked at SPECIFICATION_VALIDATION):\nQuestions:\n1. Should overdue items notify the owner?\nHuman's answer:\nyes");
    expect(text).toContain("Answer 2:\nQuestions: (not recorded)\nHuman's answer:\nold");
    expect(withAnswers("<ticket/>", [])).toBe("<ticket/>");
  });
});
