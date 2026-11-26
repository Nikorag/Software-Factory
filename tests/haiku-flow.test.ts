import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { stageExecutions } from "../src/db/schema.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { ROLE_PROFILE } from "../src/agents/roles.js";
import { flushOutbox } from "../src/linear/outbox.js";
import { sh } from "./helpers/git-fixture.js";
import { decisionKinds, harness, impl, job, type H } from "./helpers/impl-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(h: H, cond: () => boolean, ticks = 80) { for (let i = 0; i < ticks && !cond(); i++) { await h.engine.tick(); if (!cond()) await sleep(12); } }
const stageOf = (h: H) => job(h).stage;
const FAST = { mergePollMs: 15 };

describe.skipIf(!sandboxAvailable())("haiku_prompt planning mode (the default): ticket -> Haiku-written prompt -> implementation -> checks -> PR", () => {
  it("goes from requirements to a raised PR without a single Spec Kit stage, command or artefact", async () => {
    const h = await harness({ planning: "haiku_prompt", timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    expect(stageOf(h)).toBe("MERGING");

    // No specification stage ran, and the stages that did run are the short path.
    const stages = h.stages();
    expect(stages.filter((s) => s.startsWith("SPECIFICATION_"))).toEqual([]);
    expect(stages.slice(0, 3)).toEqual(["REQUIREMENTS_ANALYSIS", "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION"]);
    expect(stages).toEqual(expect.arrayContaining(["AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION", "PULL_REQUEST_CREATION", "CI_VALIDATION", "MERGE_VALIDATION"]));

    // Nothing Spec Kit: no skills, no spec-writer or converge agent, no specs/ directory.
    const calls = h.claude.calls;
    expect(calls.some((c) => /speckit|SPECIFY_FEATURE_DIRECTORY|tasks\.md/i.test(c.prompt))).toBe(false);
    expect(calls.some((c) => c.role === "spec-writer" || c.role === "spec-reviewer" || c.role === "requirements-analyst")).toBe(false);
    expect(existsSync(join(h.wt, "specs"))).toBe(false);

    // Haiku wrote the prompt: one read-only run on the prompt_generation route, and it did not implement anything.
    const writers = calls.filter((c) => c.role === "prompt-writer");
    expect(writers).toHaveLength(1);
    expect(writers[0]).toMatchObject({ model: "haiku", profile: "read-only" });
    expect(sh(h.wt, "log", "--format=%s", "main..HEAD")).not.toMatch(/spec\(/);

    // The implementer got that prompt and the acceptance criteria, the sandboxed check tool, and the ticket as data.
    const first = impl(h)[0]!;
    expect(first.prompt).toContain("Add isOverdue(due, today) to src/due.js");
    expect(first.prompt).toContain("AC-01: isOverdue is true for a past date");
    expect(first.prompt).toContain("<ticket untrusted-data=\"true\">");
    expect(first.prompt).toMatch(/factory's check tool/);
    expect(impl(h)).toHaveLength(1); // one pass: no converge loop

    // The final reviewer judged the change against those criteria; the PR carries them as evidence.
    const final = calls.find((c) => c.role === "final-reviewer")!;
    expect(final.prompt).toContain("AC-02: isOverdue is false for today");
    expect(h.github.created).toHaveLength(1);
    expect(decisionKinds(h)).toContain("prompt.generated");

    // The safety gates are unchanged: it still ran the real checks, and still never merged.
    expect(h.github.calls.filter((c) => /merge/i.test(c))).toEqual([]);
    await flushOutbox({ db: h.ctx.handle.db, client: h.linear, linear: h.ctx.config.linear, logger: h.ctx.logger, backoffBaseMs: 0 });
    expect(h.linear.issues.get(job(h).externalId)!.state.name).toBe("Ready for review");
  });

  it("blocks with the exact questions when the ticket is genuinely ambiguous, and never starts the implementer", async () => {
    const h = await harness({ planning: "haiku_prompt", timing: FAST });
    h.claude.b.plan = () => ({ verdict: "needs_clarification", questions: ["Should overdue todos be hidden or just marked?"], prompt: "", acceptanceCriteria: [] });
    await until(h, () => stageOf(h) === "BLOCKED");
    expect(job(h).lastError).toMatch(/clarification.*1\. Should overdue todos be hidden or just marked\?/s);
    expect(impl(h)).toHaveLength(0);
    expect(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, h.jobId)).all().map((x) => x.stage)).toEqual(["REQUIREMENTS_ANALYSIS"]);
  });

  it("a blocking review finding is fixed by the same implementer session, as in every mode", async () => {
    const h = await harness({ planning: "haiku_prompt", timing: FAST });
    let n = 0;
    h.claude.b.codeReview = () => (++n === 1 ? { verdict: "changes_required", findings: [{ id: "F1", severity: "major", file: "src/due.js", line: 1, issue: "no null guard", fix: "guard null" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediation = () => ({ accepted: ["F1"], rejected: [], deferred: [], summary: "guarded" });
    h.claude.b.remediate = (cwd) => { require_write(cwd); };
    await until(h, () => stageOf(h) === "MERGING");
    expect(h.stages()).toContain("REMEDIATION");
    const fix = impl(h).find((c) => /Fix the findings/.test(c.prompt))!;
    expect(fix.prompt).not.toMatch(/tasks\.md/); // nothing refers to a task list that does not exist
    expect(fix.resumeSessionId).toBe("sess-impl");
  });

  it("defers work only a human can do to the PR instead of looping on it", async () => {
    const h = await harness({ planning: "haiku_prompt", timing: FAST });
    h.claude.b.implementResult = () => ({ summary: "done", deferred: [{ id: "visual-check", reason: "needs a real browser: check the date picker" }] });
    await until(h, () => stageOf(h) === "MERGING");
    expect(h.github.created[0]!.body).toContain("visual-check");
    expect(h.github.created[0]!.body).toContain("Needs human verification");
  });
});

import { writeFileSync } from "node:fs";
function require_write(cwd: string) { writeFileSync(join(cwd, "src", "due.js"), 'export function isOverdue(due, today) { return Boolean(due) && due < today; }\n'); }

describe("the prompt writer", () => {
  it("is read-only: Haiku writes the prompt, it cannot implement the issue", () => {
    expect(ROLE_PROFILE["prompt-writer"]).toBe("read-only");
  });
});
