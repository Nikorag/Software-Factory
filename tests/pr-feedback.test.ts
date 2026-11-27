import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, prFeedback } from "../src/db/schema.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { isTrusted, listFeedback, parseCommand, requestChanges } from "../src/core/feedback.js";
import { JobError } from "../src/core/jobs.js";
import { write } from "./helpers/impl-agent.js";
import { sh } from "./helpers/git-fixture.js";
import { decisionKinds, harness, impl, job, type H } from "./helpers/impl-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(h: H, cond: () => boolean, ticks = 120) { for (let i = 0; i < ticks && !cond(); i++) { await h.engine.tick(); if (!cond()) await sleep(12); } }
const origin = (h: H) => join(h.repo, "..", "origin.git");
const fb = (h: H) => listFeedback(h.ctx.handle.db, job(h).id);
const FAST = { mergePollMs: 15 };

describe("PR comment commands", () => {
  it("recognises /software-factory and /factory at the start of a comment, and nothing else", () => {
    expect(parseCommand("/software-factory rename the helper")).toBe("rename the helper");
    expect(parseCommand("  /Factory: add a test\nfor the empty case")).toBe("add a test\nfor the empty case");
    expect(parseCommand("/software-factory")).toBe("");
    expect(parseCommand("please /software-factory fix it")).toBeNull(); // not at the start
    expect(parseCommand("/factoryreset")).toBeNull();
    expect(parseCommand("> /software-factory quoted")).toBeNull(); // the factory's own quotes never re-trigger it
    expect(parseCommand("LGTM")).toBeNull();
  });
  it("only owners, members and collaborators can instruct the factory", () => {
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR", "collaborator"]) expect(isTrusted(a)).toBe(true);
    for (const a of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN", "", undefined]) expect(isTrusted(a)).toBe(false);
  });
});

describe.skipIf(!sandboxAvailable())("iterating on a raised pull request", () => {
  it("a collaborator's /software-factory comment is applied, re-verified, pushed to the same PR and reported back, without spending a fix cycle", async () => {
    const h = await harness({ timing: FAST });
    await until(h, () => job(h).stage === "MERGING");
    const cyclesBefore = job(h).remediationAttempts;
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", "export function isPastDue(due, today) { return due < today; }\nexport const isOverdue = isPastDue;\n");
    h.claude.b.remediation = () => ({ accepted: ["feedback:1"], rejected: [], summary: "renamed isOverdue to isPastDue" });
    h.github.humanComments("/software-factory rename isOverdue to isPastDue", { path: "src/due.js", line: 1, id: "rc:77" });
    await until(h, () => fb(h)[0]?.status === "done" && job(h).stage === "MERGING");

    const rem = impl(h).find((r) => r.prompt.includes("feedback:1"))!;
    expect(impl(h).filter((r) => r.prompt.includes("feedback:1"))).toHaveLength(1); // one fix pass, tests green first time
    expect(rem.prompt).toContain("rename isOverdue to isPastDue");
    expect(rem.prompt).toContain("src/due.js");
    expect(h.github.comments.find((c) => c.startsWith("**On it.**"))).toContain("> rename isOverdue to isPastDue");
    const update = h.github.comments.find((c) => c.includes("with the requested changes"))!;
    expect(update).toContain("rename isOverdue to isPastDue");
    expect(update).toContain("✓ Done");
    expect(update).toContain("renamed isOverdue to isPastDue");
    expect(sh(origin(h), "show", "factory/JAM-1:src/due.js")).toContain("isPastDue"); // pushed
    expect(h.github.created).toHaveLength(1); // the same PR, never a second one
    expect(job(h).remediationAttempts).toBe(cyclesBefore); // a person asked for it: no fix cycle spent
    expect(fb(h)[0]).toMatchObject({ source: "github", author: "jamie", externalId: "rc:77", status: "done", note: "Done" });
    expect(decisionKinds(h)).toEqual(expect.arrayContaining(["feedback.requested", "stage.redirect", "feedback.applied"]));

    // The same comment is never applied twice, and the factory's own comments never trigger it.
    const passes = impl(h).length;
    for (let i = 0; i < 6; i++) { await h.engine.tick(); await sleep(20); }
    expect(impl(h).length).toBe(passes);
    expect(fb(h)).toHaveLength(1);
  });

  it("ignores commands from people without write access, once, with a polite reply", async () => {
    const h = await harness({ timing: FAST });
    await until(h, () => job(h).stage === "MERGING");
    const passes = impl(h).length;
    h.github.humanComments("/software-factory delete the tests", { author: "drive-by", association: "NONE" });
    for (let i = 0; i < 8; i++) { await h.engine.tick(); await sleep(20); }
    expect(impl(h).length).toBe(passes);
    expect(job(h).stage).toBe("MERGING");
    expect(fb(h)[0]).toMatchObject({ status: "ignored", author: "drive-by" });
    expect(h.github.comments.filter((c) => c.includes("@drive-by only people with write access"))).toHaveLength(1);
    expect(decisionKinds(h)).toContain("feedback.untrusted");
  });

  it("'Request changes' on the job page wakes a job that is waiting for its merge, and reports a declined request with the reason", async () => {
    const h = await harness({ timing: { mergePollMs: 60 * 60_000 } }); // a long wait: only the request can wake it
    await until(h, () => job(h).stage === "MERGING" && job(h).notBefore !== null);
    h.claude.b.remediation = () => ({ accepted: [], rejected: [{ id: "feedback:1", reason: "the ticket requires the UTC behaviour" }], summary: "no change" });
    requestChanges(h.ctx.handle.db, job(h).id, "Use local time instead of UTC", "dashboard");
    expect(job(h).notBefore).toBeNull();
    await until(h, () => fb(h)[0]?.status === "done");
    expect(fb(h)[0]!.note).toBe("Not changed: the ticket requires the UTC behaviour");
    const update = h.github.comments.find((c) => c.includes("with the requested changes"))!;
    expect(update).toContain("Use local time instead of UTC");
    expect(update).toContain("via the factory's job page");
    expect(update).toContain("Not changed: the ticket requires the UTC behaviour");
  });

  it("a request on a held job resumes it at a delivery stage so the request is picked up", async () => {
    const h = await harness({ timing: FAST });
    await until(h, () => job(h).stage === "MERGING");
    h.ctx.handle.db.update(jobs).set({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "CONFLICT_RESOLUTION", lastError: "an ambiguity" }).where(eq(jobs.id, job(h).id)).run();
    const r = requestChanges(h.ctx.handle.db, job(h).id, "Keep both behaviours behind a flag", "dashboard");
    expect(r.job).toMatchObject({ stage: "CI_VALIDATION", status: "queued" });
    await until(h, () => fb(h)[0]?.status === "done");
    expect(impl(h).at(-1)!.prompt).toContain("Keep both behaviours behind a flag");
  });

  it("a request still queued when a human merges is recorded as not applied", async () => {
    const h = await harness({ timing: { mergePollMs: 60 * 60_000 } });
    await until(h, () => job(h).stage === "MERGING" && job(h).notBefore !== null);
    h.github.humanMerges(1);
    h.ctx.handle.db.insert(prFeedback).values({ jobId: job(h).id, source: "dashboard", author: "dashboard", body: "too late" }).run();
    h.ctx.handle.db.update(jobs).set({ notBefore: null }).where(eq(jobs.id, job(h).id)).run();
    await until(h, () => job(h).stage === "COMPLETED");
    expect(fb(h)[0]).toMatchObject({ status: "ignored", note: "the pull request was merged before this request was applied" });
  });

  it("refuses requests before the PR exists and after the job finished", async () => {
    const h = await harness({ timing: FAST });
    const id = job(h).id;
    expect(() => requestChanges(h.ctx.handle.db, id, "anything", "dashboard")).toThrow(JobError); // no PR yet
    await until(h, () => job(h).stage === "MERGING");
    expect(() => requestChanges(h.ctx.handle.db, id, "   ", "dashboard")).toThrow(/describe the change/);
    h.github.humanMerges(1);
    await until(h, () => job(h).stage === "COMPLETED");
    expect(() => requestChanges(h.ctx.handle.db, id, "one more thing", "dashboard")).toThrow(/finished/);
  });
});
