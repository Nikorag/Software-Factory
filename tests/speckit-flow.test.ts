import { join } from "node:path";
import { fixtureConfig } from "./helpers/config.js";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createContext, type Context } from "../src/app/context.js";
import { ModelsConfig, ProjectConfig, type LoadedConfig } from "../src/config/schema.js";
import { Engine } from "../src/core/engine.js";
import { jobs as jobsTable } from "../src/db/schema.js";
import { answerJob, enqueue, getJob, retryJob } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { projects as projectsTable, agentInvocations, artifacts, decisions, linearOutbox, stageExecutions, worktrees } from "../src/db/schema.js";
import { createLinearReporter } from "../src/linear/reporter.js";
import { defaults, exists, fixture, overwrite, ScriptedAgent } from "./helpers/scripted-agent.js";
import { FakeLinear } from "./helpers/fake-linear.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";

interface Harness { ctx: Context; claude: ScriptedAgent; local: ScriptedAgent; linear: FakeLinear; repo: string; jobId: string; engine: Engine; stages: () => string[]; hist: () => string[] }

function harness(o: { initialised?: boolean; localModel?: string; fallback?: "claude" | "block"; noLinear?: boolean; noReviewer?: boolean } = {}): Harness {
  const { repo } = makeRepo(o.initialised === false ? { "README.md": "x" } : { "README.md": "x", ".specify/init-options.json": "{}", ".specify/.gitignore": "feature.json\n", ".claude/skills/speckit-specify/SKILL.md": "skill" });
  const base = fixtureConfig();
  const project = ProjectConfig.parse({ id: "p", name: "P", repository: repo, linear: { teamKey: "JAM" }, commands: { test: "npm test" } });
  const route = (provider: string, model: string) => ({ provider, model });
  const config: LoadedConfig = {
    ...base,
    factory: { ...base.factory, dataDir: join(repo, "..", "data") },
    projects: { projects: [project] },
    models: ModelsConfig.parse({
      independentReviewFallback: o.fallback ?? "claude",
      routes: {
        // default: Claude Haiku does classification and the independent review; `localModel` switches those two to a local route
        classification: o.localModel ? route("local", o.localModel) : route("anthropic", "haiku"), specification: route("anthropic", "default"), implementation: route("anthropic", "default"),
        independent_review: o.noReviewer ? undefined : o.localModel ? route("local", o.localModel) : route("anthropic", "haiku"), final_review: route("anthropic", "default"),
      },
    }),
  };
  const claude = new ScriptedAgent("anthropic");
  const local = new ScriptedAgent("local");
  const linear = new FakeLinear();
  const issue = linear.addIssue({ key: "JAM-1", team: "JAM" });
  issue.title = "Optional due dates for todos";
  const ctx = createContext(config, { db: openDb(":memory:"), logger: pino({ level: "silent" }), linear: o.noLinear ? undefined : linear, agents: { anthropic: claude, local } });
  ctx.handle.db.update(projectsTable).set({ validationJson: JSON.stringify({ ok: true }) }).run();
  const jobId = enqueue(ctx.handle.db, { projectId: "p", externalId: issue.id, externalKey: "JAM-1" }).job.id;
  const engine = new Engine({ db: ctx.handle.db, logger: pino({ level: "silent" }), config, handlers: ctx.handlers, backoffBaseMs: 0, observer: createLinearReporter(ctx.handle.db) });
  const hist = () => ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, jobId)).all().map((r) => `${r.stage}:${r.outcome}`);
  return { ctx, claude, local, linear, repo, jobId, engine, hist, stages: () => hist().map((h) => h.split(":")[0]!) };
}
const job = (h: Harness) => getJob(h.ctx.handle.db, h.jobId)!;
const wt = (h: Harness) => h.ctx.handle.db.select().from(worktrees).get()!.path;
const decisionKinds = (h: Harness) => h.ctx.handle.db.select().from(decisions).all().map((d) => d.kind);

describe("specification pipeline (real engine, handlers, git; scripted agents)", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it("takes a ticket to a validated, committed specification and hands over to implementation", async () => {
    await h.engine.tick();
    expect(h.hist()).toEqual([
      "DISCOVERED:succeeded", "ELIGIBILITY_CHECK:succeeded", "REQUIREMENTS_ANALYSIS:succeeded", "SPECIFICATION_GENERATION:succeeded", "SPECIFICATION_REVIEW:succeeded", "SPECIFICATION_VALIDATION:succeeded",
      "IMPLEMENTATION_PREPARATION:failed", // the implementation stages take over; this harness project has no real project to build
    ]);
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "IMPLEMENTATION_PREPARATION" });
    expect(job(h).lastError).toMatch(/already fail|baseline|test command/i);

    const dir = "specs/jam-1-optional-due-dates-for-todos";
    for (const f of ["ticket.md", "spec.md", "plan.md", "tasks.md", "checklists/requirements.md", "data-model.md"]) expect(exists(wt(h), `${dir}/${f}`)).toBe(true);
    expect(sh(wt(h), "rev-parse", "--abbrev-ref", "HEAD")).toBe("factory/JAM-1");
    const log = sh(wt(h), "log", "--format=%an|%s", "origin/main..HEAD").split("\n");
    expect(log).toEqual(expect.arrayContaining(["Software Factory|spec(JAM-1): specify", "Software Factory|spec(JAM-1): plan", "Software Factory|spec(JAM-1): tasks"]));
    expect(sh(wt(h), "status", "--porcelain")).toBe("");
    expect(sh(h.repo, "status", "--porcelain")).toBe(""); // the original checkout is untouched
  });
  it("never commits Spec Kit's machine-local .specify/feature.json (gitignored by Spec Kit itself)", async () => {
    await h.engine.tick();
    expect(exists(wt(h), ".specify/feature.json")).toBe(true);
    expect(sh(wt(h), "ls-files", ".specify/feature.json")).toBe("");
    expect(sh(wt(h), "status", "--porcelain")).toBe("");
  });
  it("records artefact references, agent invocations and the independent review", async () => {
    await h.engine.tick();
    const kinds = new Set(h.ctx.handle.db.select().from(artifacts).all().map((a) => a.kind));
    for (const k of ["spec", "plan", "tasks", "checklist", "step:specify", "step:clarify", "step:plan", "step:tasks"]) expect(kinds).toContain(k);
    const agents = h.ctx.handle.db.select().from(agentInvocations).all().map((a) => a.agent);
    expect(agents.filter((a) => a === "anthropic/classifier")).toHaveLength(1);
    expect(agents.filter((a) => a === "anthropic/spec-writer")).toHaveLength(4);
    expect(agents.filter((a) => a === "anthropic/spec-reviewer")).toHaveLength(2); // independent review + analyze
    expect(decisionKinds(h)).toContain("review.result");
    expect(decisionKinds(h)).not.toContain("review.degraded");
  });
  it("reviews with a different, cheaper model (Haiku) than the one that wrote the spec", async () => {
    await h.engine.tick();
    const reviewCall = h.claude.calls.find((c) => c.role === "spec-reviewer" && "verdict" in ((c.jsonSchema?.properties ?? {}) as object))!;
    expect(reviewCall.model).toBe("haiku");
    expect(reviewCall.profile).toBe("read-only"); // a reviewer can never edit
    expect(h.claude.calls.filter((c) => c.role === "spec-writer").every((c) => c.model === "default")).toBe(true);
    expect(h.claude.calls.find((c) => c.role === "classifier")!.model).toBe("haiku");
    expect(h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "review.result")).get()!.rationale).toBe("haiku");
  });
  it("gives every spec-writing agent the ticket as fenced data, a pinned feature dir, and project commands", async () => {
    await h.engine.tick();
    const gen = h.claude.calls.filter((c) => c.role === "spec-writer");
    expect(gen.map((c) => /speckit-(\w+)/.exec(c.prompt)![1])).toEqual(["specify", "clarify", "plan", "tasks"]);
    expect(gen[0]!.prompt).toContain('untrusted-data="true"');
    expect(gen.every((c) => c.prompt.includes("SPECIFY_FEATURE_DIRECTORY=specs/jam-1-optional-due-dates-for-todos"))).toBe(true);
    expect(gen[3]!.prompt).toContain("npm test");
    expect(gen.every((c) => c.profile === "spec-writer")).toBe(true);
  });
  it("reports status to Linear through the outbox", async () => {
    await h.engine.tick();
    const ops = h.ctx.handle.db.select().from(linearOutbox).all();
    expect(ops.some((o) => o.kind === "set_state" && o.payloadJson.includes("specificationReview"))).toBe(true);
    expect(ops.some((o) => o.kind === "add_label" && o.payloadJson.includes("blocked"))).toBe(true); // the M7 stop
  });
});

describe("eligibility is re-checked against the live ticket", () => {
  it("stops, with the reason, if the ticket lost its opt-in label after discovery", async () => {
    const h = harness();
    h.linear.issues.get(h.ctx.handle.db.select().from(jobsTable).get()!.externalId)!.labels = [];
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "ELIGIBILITY_CHECK" });
    expect(job(h).lastError).toMatch(/no longer eligible.*missing label factory:enabled/);
    expect(h.claude.calls).toHaveLength(0);
  });
  it("stops if someone marked the ticket factory:blocked", async () => {
    const h = harness();
    const issue = h.linear.issues.get(job(h).externalId)!;
    issue.labels.push(h.linear.labelDefs.find((l) => l.name === "factory:blocked")!);
    await h.engine.tick();
    expect(job(h).lastError).toMatch(/factory:blocked/);
  });
});

describe("requirements analysis", () => {
  it("blocks with the analyst's exact questions and writes nothing", async () => {
    const h = harness();
    h.claude.b.analysis = () => ({ verdict: "needs_clarification", summary: "vague", questions: ["Which database?", "Who can edit?"], risks: [] });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "REQUIREMENTS_ANALYSIS" });
    expect(job(h).lastError).toContain("1. Which database?");
    expect(h.stages()).toEqual(["DISCOVERED", "ELIGIBILITY_CHECK", "REQUIREMENTS_ANALYSIS"]);
    expect(h.ctx.handle.db.select().from(linearOutbox).all().some((o) => o.kind === "comment" && o.payloadJson.includes("Which database?"))).toBe(true);
  });
  it("a failing Claude/Haiku reviewer is an ordinary stage failure, never a silent fallback", async () => {
    const h = harness();
    const orig = h.claude.run.bind(h.claude);
    h.claude.run = async (req) => (req.model === "haiku" && req.jsonSchema && "verdict" in (req.jsonSchema.properties as object) ? { ok: false, text: "", denials: [], exitCode: 1, durationMs: 1, failure: "timeout", error: "slow" } : orig(req));
    await h.engine.tick();
    expect(decisionKinds(h)).not.toContain("review.degraded");
    expect(h.hist()).toContain("SPECIFICATION_REVIEW:failed");
  });
  it("carries on without the classifier when a local one is configured but missing (advisory only)", async () => {
    const h = harness({ localModel: "UNCONFIGURED-QWEN" });
    await h.engine.tick();
    expect(decisionKinds(h)).toContain("classification.skipped");
    expect(h.stages()).toContain("SPECIFICATION_VALIDATION");
  });
});

describe("no independent reviewer configured", () => {
  it("skips the spec review without calling any model, records why, and carries on", async () => {
    const h = harness({ noReviewer: true });
    await h.engine.tick();
    expect(h.hist()).toContain("SPECIFICATION_REVIEW:succeeded");
    expect(h.stages()).toContain("SPECIFICATION_VALIDATION");
    expect(decisionKinds(h)).toContain("review.skipped");
    expect(decisionKinds(h)).not.toContain("review.degraded");
    expect(h.local.calls).toHaveLength(0);
    expect(h.claude.calls.some((c) => c.role === "spec-reviewer" && c.model === "haiku")).toBe(false); // what the independent route would have run (later validation uses the Claude review route)
  });
  it("uses a local reviewer when one is configured (and does not record a skip)", async () => {
    const h = harness({ localModel: "qwen-x" });
    h.local.b = defaults();
    await h.engine.tick();
    expect(h.local.calls.some((c) => c.role === "spec-reviewer")).toBe(true);
    expect(decisionKinds(h)).not.toContain("review.skipped");
  });
});

describe("independent review fallback (only for a local route)", () => {
  it("falls back to a fresh Claude reviewer, and says so, when the local model is not configured", async () => {
    const h = harness({ localModel: "UNCONFIGURED-QWEN" });
    await h.engine.tick();
    expect(decisionKinds(h)).toContain("review.degraded");
    expect(h.claude.calls.some((c) => c.role === "spec-reviewer" && c.jsonSchema && "verdict" in (c.jsonSchema.properties as object))).toBe(true);
    expect(h.stages()).toContain("SPECIFICATION_VALIDATION");
  });
  it("blocks instead when configured to require a genuinely independent reviewer", async () => {
    const h = harness({ localModel: "UNCONFIGURED-QWEN", fallback: "block" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "SPECIFICATION_REVIEW" });
    expect(job(h).lastError).toMatch(/fallback is "block"/);
  });
  it("falls back when a configured local server errors, not only when unconfigured", async () => {
    const h = harness({ localModel: "qwen-x" });
    h.local.run = async () => ({ ok: false, text: "", denials: [], exitCode: null, durationMs: 1, failure: "transient", error: "unreachable" });
    h.local.b = defaults();
    await h.engine.tick();
    expect(decisionKinds(h)).toContain("review.degraded");
  });
});

const specFixes = (h: ReturnType<typeof harness>) => h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "remediation")).all().length;

describe("review -> remediation loop", () => {
  it("fixes blocking findings, records rejected ones with their reasons, and tells the agent exactly what to fix", async () => {
    const h = harness();
    let reviews = 0;
    h.claude.b.review = () => (++reviews === 1
      ? { verdict: "changes_required", findings: [{ id: "R1", severity: "blocker", section: "FR-002", issue: "Date format is ambiguous", fix: "Specify ISO 8601" }, { id: "R2", severity: "major", section: "SC-001", issue: "Not measurable", fix: "Add a number" }, { id: "R3", severity: "minor", section: "x", issue: "typo", fix: "fix" }] }
      : { verdict: "approve", findings: [] });
    h.claude.b.remediation = () => ({ accepted: ["R1"], rejected: [{ id: "R2", reason: "SC-001 already states 100%" }], summary: "ok" });
    h.claude.b.onRemediate = (req, dir) => overwrite(req.cwd, `${dir}/spec.md`, fixture("spec.md") + "\n\n<!-- R1: date format clarified -->\n");
    await h.engine.tick();
    expect(h.stages().slice(2, 8)).toEqual(["REQUIREMENTS_ANALYSIS", "SPECIFICATION_GENERATION", "SPECIFICATION_REVIEW", "SPECIFICATION_REMEDIATION", "SPECIFICATION_VALIDATION", "IMPLEMENTATION_PREPARATION"]);
    expect(specFixes(h)).toBe(1);
    expect(job(h).remediationAttempts).toBe(0); // the code phase starts with a fresh fix-cycle budget
    const rem = h.claude.calls.find((c) => "accepted" in ((c.jsonSchema?.properties ?? {}) as object))!;
    expect(rem.prompt).toContain("R1");
    expect(rem.prompt).toContain("R2");
    expect(rem.prompt).not.toContain("R3"); // minor findings do not block and are not sent
    expect(rem.profile).toBe("spec-writer");
    const rej = h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "remediation.rejected")).get()!;
    expect(rej).toMatchObject({ decision: "R2", rationale: "SC-001 already states 100%" });
    expect(sh(wt(h), "log", "--format=%s", "-1")).toBe("spec(JAM-1): address review findings");
  });
  it("escalates to NEEDS_ATTENTION after three failed remediation cycles instead of looping", async () => {
    const h = harness();
    h.claude.b.analyze = () => ({ summary: "x", findings: [{ id: "A1", category: "Inconsistency", severity: "CRITICAL", location: "plan.md", summary: "never fixed", recommendation: "r" }] });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 3 });
    expect(h.hist().filter((x) => x === "SPECIFICATION_REMEDIATION:succeeded")).toHaveLength(3);
    expect(job(h).lastError).toMatch(/remediation attempts exhausted/);
  });
});

describe("specification validation", () => {
  it("sends deterministic check failures to remediation, then passes once fixed", async () => {
    const h = harness();
    h.claude.b.onStep = (step, req, dir) => { if (step === "specify") overwrite(req.cwd, `${dir}/spec.md`, "# Spec\n\n" + "filler text without any requirements. ".repeat(20)); };
    h.claude.b.onRemediate = (req, dir) => overwrite(req.cwd, `${dir}/spec.md`, fixture("spec.md"));
    await h.engine.tick();
    const findings = h.claude.calls.find((c) => "accepted" in ((c.jsonSchema?.properties ?? {}) as object))!.prompt;
    expect(findings).toContain("check:has-requirements");
    expect(specFixes(h)).toBe(1);
    expect(job(h).remediationAttempts).toBe(0); // the code phase starts with a fresh fix-cycle budget
    expect(h.stages()).toContain("SPECIFICATION_REMEDIATION");
    expect(h.stages().filter((s) => s === "SPECIFICATION_VALIDATION")).toHaveLength(2);
  });
  it("sends CRITICAL/HIGH analyze findings to remediation but lets MEDIUM/LOW through as notes", async () => {
    const h = harness();
    let n = 0;
    h.claude.b.analyze = () => ({ summary: "x", findings: ++n === 1
      ? [{ id: "A1", category: "Inconsistency", severity: "HIGH", location: "plan.md", summary: "plan contradicts spec", recommendation: "align" }, { id: "A2", category: "Style", severity: "LOW", location: "t", summary: "nit", recommendation: "r" }]
      : [{ id: "A2", category: "Style", severity: "MEDIUM", location: "t", summary: "nit", recommendation: "r" }] });
    await h.engine.tick();
    expect(specFixes(h)).toBe(1);
    expect(job(h).remediationAttempts).toBe(0); // the code phase starts with a fresh fix-cycle budget
    expect(h.claude.calls.find((c) => "accepted" in ((c.jsonSchema?.properties ?? {}) as object))!.prompt).toContain("analyze:A1");
    expect(h.stages()).toContain("IMPLEMENTATION_PREPARATION"); // MEDIUM did not block
  });
  it("blocks for a human when the spec lists open questions, quoting them", async () => {
    const h = harness();
    h.claude.b.onStep = (step, req, dir) => { if (step === "tasks") overwrite(req.cwd, `${dir}/spec.md`, fixture("spec.md") + "\n\n## Open questions requiring a human\n\n- Should overdue items notify the owner?\n"); };
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "SPECIFICATION_VALIDATION" });
    expect(job(h).lastError).toContain("Should overdue items notify the owner?");
    expect(job(h).remediationAttempts).toBe(0);
  });
});

describe("preconditions and failure handling", () => {
  it("blocks with onboarding instructions when Spec Kit is not set up on the default branch", async () => {
    const h = harness({ initialised: false });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "SPECIFICATION_GENERATION" });
    expect(job(h).lastError).toContain("project:onboard p");
    expect(h.claude.calls.filter((c) => c.role === "spec-writer")).toHaveLength(0);
  });
  it("blocks (not crashes) when LINEAR_API_KEY is missing", async () => {
    const saved = process.env.LINEAR_API_KEY; delete process.env.LINEAR_API_KEY;
    try {
      const h = harness({ noLinear: true });
      await h.engine.tick();
      expect(job(h)).toMatchObject({ stage: "BLOCKED" });
      expect(job(h).lastError).toMatch(/LINEAR_API_KEY is not set/);
    } finally { if (saved) process.env.LINEAR_API_KEY = saved; }
  });
  it("needs attention, not a retry, on a Claude login failure", async () => {
    const h = harness();
    h.claude.run = async () => ({ ok: false, text: "", denials: [], exitCode: 1, durationMs: 1, failure: "auth", error: "not logged in" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/not logged in/);
  });
  it("needs attention and preserves the worktree when an agent touches a protected path", async () => {
    const h = harness();
    h.claude.b.onStep = (step, req) => { if (step === "specify") overwrite(req.cwd, ".env", "SECRET=1"); };
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/boundary violation.*\.env/);
    expect(exists(wt(h), ".env")).toBe(true); // left in place for investigation
    expect(decisionKinds(h)).toContain("agent.violation");
  });
  it("retries a transient agent failure and resumes at the failed step, never redoing completed ones", async () => {
    const h = harness();
    let planFailures = 1;
    const orig = h.claude.run.bind(h.claude);
    h.claude.run = async (req) => {
      if (/speckit-plan\/SKILL/.test(req.prompt) && planFailures-- > 0) { h.claude.calls.push(req); return { ok: false, text: "", denials: [], exitCode: 1, durationMs: 1, failure: "transient", error: "overloaded" }; }
      return orig(req);
    };
    await h.engine.tick(); await h.engine.tick(); await h.engine.tick();
    const stepsRun = h.claude.calls.filter((c) => c.role === "spec-writer").map((c) => /speckit-(\w+)/.exec(c.prompt)![1]);
    expect(stepsRun.filter((s) => s === "specify")).toHaveLength(1); // checkpointed
    expect(stepsRun.filter((s) => s === "clarify")).toHaveLength(1);
    expect(stepsRun.filter((s) => s === "plan")).toHaveLength(2); // failed once, then succeeded
    expect(h.hist()).toContain("SPECIFICATION_GENERATION:failed");
    expect(h.stages()).toContain("SPECIFICATION_VALIDATION");
  });
  it("reruns a step once, in the same attempt, when it finishes without writing its file (seen live)", async () => {
    const h = harness();
    h.claude.b.skipWrite = (step, n) => step === "tasks" && n === 1;
    await h.engine.tick();
    expect(h.claude.calls.filter((c) => /speckit-tasks\//.test(c.prompt))).toHaveLength(2);
    expect(h.hist()).not.toContain("SPECIFICATION_GENERATION:failed"); // recovered inside one attempt: no stage retry, no backoff
    expect(h.stages()).toContain("SPECIFICATION_VALIDATION");
    const d = h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "speckit.step.rerun")).get()!;
    expect(d.decision).toContain("tasks");
    expect(d.rationale).toContain("Write"); // what was denied is recorded
  });
  it("fails the stage (retryably, naming what was denied) when a step is empty twice", async () => {
    const h = harness();
    h.claude.b.skipWrite = (step) => step === "tasks";
    await h.engine.tick();
    expect(h.hist()).toContain("SPECIFICATION_GENERATION:failed");
    expect(job(h).lastError).toMatch(/tasks\.md|missing or empty/);
    expect(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "SPECIFICATION_GENERATION")).get()!.error).toMatch(/denied: Write/);
    expect(h.claude.calls.filter((c) => /speckit-specify\//.test(c.prompt))).toHaveLength(1); // earlier steps stay checkpointed
  });
  it("is dry-run safe: read-only analysis runs, but nothing is generated or committed", async () => {
    const h = harness();
    h.ctx.handle.db.update((await import("../src/db/schema.js")).jobs).set({ dryRun: true }).run();
    await h.engine.tick();
    expect(h.claude.calls.filter((c) => c.role === "spec-writer")).toHaveLength(0);
    expect(decisionKinds(h)).toContain("dry-run");
  });
});

describe("answering a held job's questions", () => {
  const QUESTIONS = "\n\n## Open questions requiring a human\n\n- Should overdue items notify the owner?\n";
  const remediations = (h: Harness) => h.claude.calls.filter((c) => "accepted" in ((c.jsonSchema?.properties ?? {}) as object));
  const specWithQuestions = (h: Harness) => { h.claude.b.onStep = (step, req, dir) => { if (step === "tasks") overwrite(req.cwd, `${dir}/spec.md`, fixture("spec.md") + QUESTIONS); }; };

  it("spec open questions: the answer reaches the spec-writer with its question, and validation then passes", async () => {
    const h = harness();
    specWithQuestions(h);
    let reviews = 0;
    h.claude.b.review = () => (++reviews === 1
      ? { verdict: "changes_required", findings: [{ id: "R1", severity: "blocker", section: "FR-002", issue: "Date format is ambiguous", fix: "Specify ISO 8601" }] }
      : { verdict: "approve", findings: [] });
    let fixes = 0;
    // The first remediation (for R1) leaves the open question in place; the one after the answer resolves it.
    h.claude.b.onRemediate = (req, dir) => overwrite(req.cwd, `${dir}/spec.md`, fixture("spec.md") + (++fixes === 1 ? QUESTIONS : "\n\n## Open questions requiring a human\n\nNone.\n"));
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "SPECIFICATION_VALIDATION" });
    expect(job(h).lastError).toContain("Answer on the job page");

    answerJob(h.ctx.handle.db, h.jobId, "Yes, email the owner when an item becomes overdue.", "dashboard");
    await h.engine.tick();

    const rem = remediations(h);
    expect(rem).toHaveLength(2);
    const prompt = rem[1]!.prompt;
    expect(prompt).toContain('"id": "human-questions"');
    expect(prompt).toContain("Should overdue items notify the owner?");
    expect(prompt).toContain("Yes, email the owner when an item becomes overdue.");
    expect(prompt).toContain("asked at SPECIFICATION_VALIDATION");
    expect(prompt).not.toContain('"id": "R1"'); // already fixed: not re-sent
    expect(h.hist().slice(-3)).toEqual(["SPECIFICATION_REMEDIATION:succeeded", "SPECIFICATION_VALIDATION:succeeded", "IMPLEMENTATION_PREPARATION:failed"]);
    expect(job(h).heldFromStage).toBe("IMPLEMENTATION_PREPARATION");
    expect(sh(wt(h), "log", "--format=%s", "-1")).toBe("spec(JAM-1): apply answers to open questions");
  });

  it("spec open questions: answering in the ticket and retrying goes through remediation instead of blocking again", async () => {
    const h = harness();
    specWithQuestions(h);
    h.claude.b.onRemediate = (req, dir) => overwrite(req.cwd, `${dir}/spec.md`, fixture("spec.md"));
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "SPECIFICATION_VALIDATION" });
    h.linear.issues.get(job(h).externalId)!.comments.push({ id: "c1", body: "Overdue items should notify the owner.", createdAt: "now", userName: "Jamie" });

    retryJob(h.ctx.handle.db, h.jobId, "dashboard");
    await h.engine.tick();

    const rem = remediations(h);
    expect(rem).toHaveLength(1);
    expect(rem[0]!.prompt).toContain("Should overdue items notify the owner?");
    expect(rem[0]!.prompt).toContain("Overdue items should notify the owner."); // the ticket comment
    expect(rem[0]!.prompt).toContain("answer in the ticket");
    expect(h.stages()).toContain("IMPLEMENTATION_PREPARATION");
  });

  it("blocks again, rather than looping, when the answers do not resolve the questions", async () => {
    const h = harness();
    specWithQuestions(h);
    await h.engine.tick(); // default remediation changes nothing
    answerJob(h.ctx.handle.db, h.jobId, "not sure yet", "dashboard");
    await h.engine.tick();
    expect(remediations(h)).toHaveLength(1);
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "SPECIFICATION_VALIDATION" });
    expect(job(h).lastError).toContain("Should overdue items notify the owner?");
  });

  it("requirements clarification: resumes at analysis and the analyst sees each question paired with its answer", async () => {
    const h = harness();
    let analyses = 0;
    h.claude.b.analysis = () => (++analyses === 1
      ? { verdict: "needs_clarification", summary: "vague", questions: ["Which database?", "Who can edit?"], risks: [] }
      : { verdict: "ready", summary: "clear", questions: [], risks: [] });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "REQUIREMENTS_ANALYSIS" });

    expect(answerJob(h.ctx.handle.db, h.jobId, "SQLite; only the owner.", "dashboard").stage).toBe("REQUIREMENTS_ANALYSIS");
    await h.engine.tick();

    const analyst = h.claude.calls.filter((c) => c.role === "requirements-analyst");
    expect(analyst).toHaveLength(2);
    const prompt = analyst[1]!.prompt;
    expect(prompt).toContain("asked at REQUIREMENTS_ANALYSIS");
    expect(prompt).toMatch(/1\. Which database\?\n2\. Who can edit\?\nHuman's answer:\nSQLite; only the owner\./);
    expect(prompt).toContain("treat those questions as resolved");
    expect(prompt).not.toContain("Answer on the job page"); // the advice to the human is not part of the question
    expect(h.stages()).toContain("SPECIFICATION_VALIDATION");
    // later agents see the pair too
    expect(h.claude.calls.find((c) => c.role === "spec-writer")!.prompt).toContain("Which database?");
  });
});
