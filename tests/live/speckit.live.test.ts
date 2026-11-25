import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContext } from "../../src/app/context.js";
import { loadConfig } from "../../src/config/load.js";
import { ModelsConfig, ProjectConfig, type LoadedConfig } from "../../src/config/schema.js";
import { Engine } from "../../src/core/engine.js";
import { createLinearReporter } from "../../src/linear/reporter.js";
import { enqueue, getJob } from "../../src/core/jobs.js";
import { openDb } from "../../src/db/client.js";
import { agentInvocations, decisions, jobs, projects, stageExecutions, worktrees } from "../../src/db/schema.js";
import { initSpecKit, commitPaths } from "../../src/speckit/tools.js";
import { readSpecBundle, validateSpecArtifacts } from "../../src/speckit/artifacts.js";
import { FakeLinear } from "../helpers/fake-linear.js";
import { makeRepo, sh } from "../helpers/git-fixture.js";

// REAL claude + REAL specify through the real engine and handlers. Only Linear is faked (nothing is written to
// your workspace). Takes several minutes and uses subscription quota.   FACTORY_LIVE=1 pnpm vitest run tests/live/speckit
describe.skipIf(!process.env.FACTORY_LIVE)("SpecKit pipeline (live)", () => {
  it("turns a ticket into a validated, committed specification using real Claude Code and Spec Kit", async () => {
    const fx = makeRepo({
      "package.json": JSON.stringify({ name: "todo-api", type: "module", scripts: { test: "node --test" } }),
      "src/todos.js": "export function createTodoStore(){const items=[];return{add(title){items.push({id:items.length+1,title});},list(){return [...items];}};}\n",
      "README.md": "# Todo API\nA tiny in-memory todo store.\n",
    });
    await initSpecKit(fx.repo);
    await commitPaths(fx.repo, [".specify", ".claude"], "chore: init spec kit");
    sh(fx.repo, "push", "-q");

    const base = loadConfig("config");
    const project = ProjectConfig.parse({ id: "todo", name: "Todo", repository: fx.repo, linear: { teamKey: "JAM" }, commands: { test: "npm test" } });
    const r = { provider: "anthropic" as const, model: "default" };
    const config: LoadedConfig = {
      ...base, factory: { ...base.factory, dataDir: join(fx.base, "data") }, projects: { projects: [project] },
      models: ModelsConfig.parse({ independentReviewFallback: "claude", routes: { classification: { provider: "anthropic", model: "haiku" }, specification: r, implementation: r, independent_review: { provider: "anthropic", model: "haiku" }, final_review: r } }),
    };
    const linear = new FakeLinear();
    const issue = linear.addIssue({ key: "JAM-1", team: "JAM" });
    issue.title = "Show overdue todos first";
    issue.description = "Todos can have an optional due date (YYYY-MM-DD). When listing todos, any todo whose due date is before today must appear first, earliest due date first. Todos without a due date keep their current order. Invalid dates must be rejected with a clear error.";
    const ctx = createContext(config, { db: openDb(":memory:"), logger: pino({ level: "silent" }), linear });
    ctx.handle.db.update(projects).set({ validationJson: JSON.stringify({ ok: true }) }).run();
    const jobId = enqueue(ctx.handle.db, { projectId: "todo", externalId: issue.id, externalKey: "JAM-1" }).job.id;

    // Let transient failures retry (as the real scheduler would) until the job settles or reaches the M7 stop.
    const engine = new Engine({ db: ctx.handle.db, logger: pino({ level: "silent" }), config, handlers: ctx.handlers, backoffBaseMs: 500, observer: createLinearReporter(ctx.handle.db) });
    for (let i = 0; i < 12; i++) {
      await engine.tick();
      const j = getJob(ctx.handle.db, jobId)!;
      if (j.status !== "queued" && j.status !== "running") break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    const hist = ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, jobId)).all();
    const summary = hist.map((h) => `${h.stage}:${h.outcome}${h.error ? ` (${h.error.slice(0, 160)})` : ""}`);
    const job = getJob(ctx.handle.db, jobId)!;
    const reached = summary.filter((s) => s.endsWith(":succeeded")).map((s) => s.split(":")[0]);
    console.log("LIVE SUMMARY\n" + summary.join("\n") + `\nfinal: ${job.stage} (${job.lastError?.slice(0, 200)})\nremediations: ${job.remediationAttempts}\nagent calls: ${ctx.handle.db.select().from(agentInvocations).all().length}\ndecisions: ${ctx.handle.db.select().from(decisions).all().map((d) => d.kind).join(",")}`);

    const calls = ctx.handle.db.select().from(agentInvocations).all();
    writeFileSync(process.env.FACTORY_LIVE_REPORT ?? join(fx.base, "live-report.txt"), [
      ...summary, `final: ${job.stage}`, `remediations: ${job.remediationAttempts}`,
      ...calls.map((c) => `${c.agent.padEnd(28)} model=${String(c.model).padEnd(8)} ${String(Math.round((c.durationMs ?? 0) / 1000)).padStart(4)}s`),
      `total agent seconds: ${Math.round(calls.reduce((n, c) => n + (c.durationMs ?? 0), 0) / 1000)}`,
    ].join("\n"));
    expect(reached).toEqual(expect.arrayContaining(["REQUIREMENTS_ANALYSIS", "SPECIFICATION_GENERATION", "SPECIFICATION_REVIEW", "SPECIFICATION_VALIDATION"]));
    expect(job.stage).toBe("BLOCKED"); // stops at IMPLEMENTATION_PREPARATION (Milestone 7)
    expect(job.heldFromStage).toBe("IMPLEMENTATION_PREPARATION");

    const wt = ctx.handle.db.select().from(worktrees).where(eq(worktrees.jobId, jobId)).get()!.path;
    const dir = "specs/jam-1-show-overdue-todos-first";
    const bundle = readSpecBundle(wt, dir);
    expect(validateSpecArtifacts(bundle).filter((c) => !c.ok)).toEqual([]);
    expect(existsSync(join(wt, dir, "ticket.md"))).toBe(true);
    expect(readFileSync(join(wt, dir, "spec.md"), "utf8").toLowerCase()).toContain("overdue");
    expect(sh(wt, "status", "--porcelain")).toBe("");
    expect(sh(wt, "log", "--format=%s", "origin/main..HEAD")).toContain("spec(JAM-1): tasks");
    expect(sh(fx.repo, "status", "--porcelain")).toBe(""); // original checkout untouched
    expect(ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "agent.violation")).all()).toEqual([]);
    expect(ctx.handle.db.select().from(jobs).get()!.id).toBe(jobId);
  }, 30 * 60_000);
});
