import { describe, expect, it } from "vitest";
import { bucketOf, effectiveStatus, isAwaitingMerge, openJobs, projectMeta, statusLabel, toneOf, TONE } from "./projects";
import type { Job, Overview } from "./types";

const job = (o: Partial<Job> = {}): Job => ({ id: "j", key: "JAM-1", project: "p", workflow: "feature", stage: "MERGING", status: "queued", heldFromStage: null, remediationAttempts: 0, stageAttempts: 0, autonomous: false, dryRun: false, prUrl: "https://github.com/o/r/pull/1", lastError: null, notBefore: 1, createdAt: 0, updatedAt: 0, ...o });

describe("jobs awaiting a human merge", () => {
  it("is MERGING and queued or waiting, and never a held stage", () => {
    expect(isAwaitingMerge(job())).toBe(true);
    expect(isAwaitingMerge(job({ status: "waiting" }))).toBe(true);
    expect(isAwaitingMerge(job({ status: "running" }))).toBe(false);
    expect(isAwaitingMerge(job({ status: "done" }))).toBe(false);
    expect(isAwaitingMerge(job({ stage: "PULL_REQUEST_CREATION" }))).toBe(false);
    expect(isAwaitingMerge(job({ stage: "NEEDS_ATTENTION" }))).toBe(false);
  });
  it("is Done in buckets, labels, tones and the project meta, not Queued or Needs you", () => {
    for (const status of ["queued", "waiting"]) {
      const j = job({ status });
      expect(effectiveStatus(j)).toBe("done");
      expect(bucketOf(j)).toBe("done");
      expect(statusLabel(j)).toBe("Done");
      expect(toneOf(j)).toBe(TONE.ok);
    }
    expect(projectMeta([job(), job({ id: "k", status: "waiting" })]).text).toBe("idle");
  });
  it("leaves other jobs alone", () => {
    expect(statusLabel(job({ stage: "DISCOVERED" }))).toBe("Queued");
    expect(statusLabel(job({ stage: "CLAUDE_REVIEW", status: "waiting" }))).toBe("Needs you");
    expect(projectMeta([job({ stage: "DISCOVERED" })]).text).toBe("1 queued");
  });
  it("stays open (tab and rail Done group) because it still needs the human to merge; finished jobs do not", () => {
    const o = { active: [], queued: [], recent: [job(), job({ id: "k", stage: "DISCOVERED" }), job({ id: "d", status: "done", stage: "COMPLETED" })] } as unknown as Overview;
    expect(openJobs(o).map((j) => j.id)).toEqual(["j", "k"]);
    expect(bucketOf(openJobs(o)[0]!)).toBe("done");
  });
});

describe("the Bash opt-in in the project form", () => {
  it("is offered for inherited and restricted access, not unrestricted", async () => {
    const { showsBashAny } = await import("./projects");
    expect(showsBashAny("")).toBe(true);
    expect(showsBashAny("restricted")).toBe(true);
    expect(showsBashAny("unrestricted")).toBe(false);
  });
  it("is saved as the form holds it, so an inherited-access project keeps true", async () => {
    const { bashAnyPayload } = await import("./projects");
    expect(bashAnyPayload({ bashAny: true })).toBe(true);
    expect(bashAnyPayload({ bashAny: false })).toBe(false);
  });
});
