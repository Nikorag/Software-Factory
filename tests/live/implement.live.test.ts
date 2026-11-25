import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContext } from "../../src/app/context.js";
import { loadConfig } from "../../src/config/load.js";
import { ModelsConfig, ProjectConfig, type LoadedConfig } from "../../src/config/schema.js";
import { Engine } from "../../src/core/engine.js";
import { enqueue, getJob } from "../../src/core/jobs.js";
import { openDb } from "../../src/db/client.js";
import { agentInvocations, artifacts, decisions, projects, stageExecutions, worktrees } from "../../src/db/schema.js";
import { createLinearReporter } from "../../src/linear/reporter.js";
import { commitPaths, initSpecKit } from "../../src/speckit/tools.js";
import { FakeLinear } from "../helpers/fake-linear.js";
import { makeRepo, sh } from "../helpers/git-fixture.js";

// REAL claude + REAL specify + REAL sandboxed node tests, through the real engine. Only Linear is faked.
// Slow (~15-25 min) and uses subscription quota.   FACTORY_LIVE=1 pnpm vitest run tests/live/implement
describe.skipIf(!process.env.FACTORY_LIVE)("autonomous implementation (live)", () => {
  it("implements a ticket end to end: spec, code, tests run in the sandbox, reviews, final validation", async () => {
    const fx = makeRepo({
      "package.json": JSON.stringify({ name: "todo-api", type: "module", scripts: { test: "node --test test/" } }),
      "src/todos.js": "export function createTodoStore() {\n  const items = [];\n  return {\n    add(title) { items.push({ id: items.length + 1, title }); return items.at(-1); },\n    list() { return [...items]; },\n  };\n}\n",
      "test/todos.test.js": 'import test from "node:test";\nimport assert from "node:assert";\nimport { createTodoStore } from "../src/todos.js";\ntest("add then list", () => {\n  const s = createTodoStore();\n  s.add("a");\n  assert.equal(s.list().length, 1);\n});\n',
      "README.md": "# Todo API\nA tiny in-memory todo store. Run tests with `npm test`.\n",
      ".gitignore": "node_modules\n",
    });
    await initSpecKit(fx.repo);
    await commitPaths(fx.repo, [".specify", ".claude"], "chore: init spec kit");
    sh(fx.repo, "push", "-q");

    const base = loadConfig("config");
    const project = ProjectConfig.parse({ id: "todo", name: "Todo", repository: fx.repo, linear: { teamKey: "JAM" }, commands: { test: "node --test test/" } });
    const r = { provider: "anthropic" as const, model: "default" };
    const config: LoadedConfig = {
      ...base, factory: { ...base.factory, dataDir: join(fx.base, "data") }, projects: { projects: [project] },
      models: ModelsConfig.parse({ routes: { classification: { provider: "anthropic", model: "haiku" }, specification: r, implementation: r, independent_review: { provider: "anthropic", model: "haiku" }, final_review: r } }),
    };
    const linear = new FakeLinear();
    const issue = linear.addIssue({ key: "JAM-1", team: "JAM" });
    issue.title = "Show overdue todos first";
    issue.description = "Todos can have an optional due date (YYYY-MM-DD), supplied as an optional second argument to add(). list() must return todos whose due date is before today first, earliest due date first; todos without a due date keep their current order after them. list() takes an optional `today` (YYYY-MM-DD) so it is testable. An invalid due date must make add() throw an Error that mentions the offending value.";
    const ctx = createContext(config, { db: openDb(":memory:"), logger: pino({ level: "silent" }), linear });
    ctx.handle.db.update(projects).set({ validationJson: JSON.stringify({ ok: true }) }).run();
    const jobId = enqueue(ctx.handle.db, { projectId: "todo", externalId: issue.id, externalKey: "JAM-1" }).job.id;

    const engine = new Engine({ db: ctx.handle.db, logger: pino({ level: "silent" }), config, handlers: ctx.handlers, backoffBaseMs: 500, observer: createLinearReporter(ctx.handle.db) });
    for (let i = 0; i < 20; i++) {
      await engine.tick();
      const j = getJob(ctx.handle.db, jobId)!;
      if (j.status !== "queued" && j.status !== "running") break;
      await new Promise((res) => setTimeout(res, 1500));
    }

    const job = getJob(ctx.handle.db, jobId)!;
    const hist = ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, jobId)).all();
    const calls = ctx.handle.db.select().from(agentInvocations).all();
    const report = process.env.FACTORY_LIVE_REPORT ?? join(fx.base, "live-report.txt");
    const wt = ctx.handle.db.select().from(worktrees).where(eq(worktrees.jobId, jobId)).get()?.path;
    writeFileSync(report, [
      ...hist.map((h) => `${h.stage}:${h.outcome}${h.error ? ` (${h.error.slice(0, 200).replace(/\n/g, " ")})` : ""}`),
      `final: ${job.stage} :: ${(job.lastError ?? "").slice(0, 300).replace(/\n/g, " ")}`, `remediations: ${job.remediationAttempts}`,
      ...calls.map((c) => `${c.agent.padEnd(30)} model=${String(c.model).padEnd(8)} ${String(Math.round((c.durationMs ?? 0) / 1000)).padStart(4)}s ${c.usageJson ? `denials=${JSON.parse(c.usageJson).denials}` : ""}`),
      `total agent seconds: ${Math.round(calls.reduce((n, c) => n + (c.durationMs ?? 0), 0) / 1000)}`,
      `decisions: ${ctx.handle.db.select().from(decisions).all().map((d) => d.kind).join(",")}`,
      wt ? `commits:\n${sh(wt, "log", "--format=%an | %s", "origin/main..HEAD")}\nfiles:\n${sh(wt, "diff", "--stat", "origin/main...HEAD")}` : "",
    ].join("\n"));

    const ok = hist.filter((h) => h.outcome === "succeeded").map((h) => h.stage);
    expect(ok).toEqual(expect.arrayContaining(["IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION"]));
    expect(job.stage).toBe("BLOCKED"); // stops at PULL_REQUEST_CREATION (Milestone 8)
    expect(job.heldFromStage).toBe("PULL_REQUEST_CREATION");

    // The result is real: run the project's own tests, unsandboxed, in the worktree.
    expect(wt && existsSync(wt)).toBe(true);
    const out = execFileSync("node", ["--test", "test/"], { cwd: wt, encoding: "utf8" });
    expect(out).toMatch(/pass \d+/);
    expect(out).toMatch(/fail 0/);
    expect(sh(wt!, "status", "--porcelain")).toBe("");
    const authors = sh(wt!, "log", "--format=%an", "origin/main..HEAD").split("\n");
    expect(sh(wt!, "log", "--format=%s", "origin/main..HEAD")).toMatch(/JAM-1/);
    expect(new Set(authors)).toEqual(new Set(["Software Factory"])); // no commit is attributed to a person
    expect(readFileSync(join(wt!, "src/todos.js"), "utf8").length).toBeGreaterThan(200);
    expect(ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "agent.violation")).all()).toEqual([]);
    const rep = ctx.handle.db.select().from(artifacts).where(eq(artifacts.kind, "completion-report")).get();
    expect(rep && readFileSync(rep.path, "utf8")).toContain("PASS `test`");
  }, 55 * 60_000);
});
