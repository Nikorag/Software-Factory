import { join } from "node:path";
import { fixtureConfig } from "./config.js";
import pino from "pino";
import { eq } from "drizzle-orm";
import { createContext, type Context } from "../../src/app/context.js";
import { ModelsConfig, ProjectConfig, type LoadedConfig } from "../../src/config/schema.js";
import { Engine } from "../../src/core/engine.js";
import { enqueue, getJob } from "../../src/core/jobs.js";
import { openDb } from "../../src/db/client.js";
import { decisions, jobs, projects, stageExecutions } from "../../src/db/schema.js";
import type { DeliveryTiming } from "../../src/delivery/handlers.js";
import { createLinearReporter } from "../../src/linear/reporter.js";
import { commitPaths } from "../../src/speckit/tools.js";
import { featureDirFor } from "../../src/speckit/artifacts.js";
import { ImplAgent, write } from "./impl-agent.js";
import { fixture } from "./scripted-agent.js";
import { FakeLinear } from "./fake-linear.js";
import { FakeGitHub } from "./fake-github.js";
import { makeRepo } from "./git-fixture.js";

export const TITLE = "Optional due dates for todos";
export const SPEC_FILES = ["spec.md", "plan.md", "tasks.md", "research.md", "data-model.md", "quickstart.md", "contracts/todo-module.md", "checklists/requirements.md"];

export interface H { github: FakeGitHub; linear: FakeLinear; ctx: Context; claude: ImplAgent; haiku: ImplAgent; repo: string; jobId: string; engine: Engine; wt: string; hist: () => string[]; stages: () => string[] }

export async function harness(o: { planning?: "speckit" | "haiku_prompt"; maxConflicts?: number; passes?: number; projectPasses?: number; commands?: Record<string, string>; baseTest?: string; noReviewer?: boolean; github?: FakeGitHub; timing?: Partial<DeliveryTiming>; clockStepMs?: number; now?: () => Date } = {}): Promise<H> {
  const { repo } = makeRepo({
    "package.json": JSON.stringify({ name: "todo", type: "module", scripts: { test: "node --test" } }),
    "src/todos.js": "export const list = () => [];\n",
    "test/todos.test.js": o.baseTest ?? 'import test from "node:test";\nimport assert from "node:assert";\nimport { list } from "../src/todos.js";\ntest("empty", () => assert.deepEqual(list(), []));\n',
    ".gitignore": "node_modules\n",
  });
  const planning = o.planning ?? "speckit";
  const base = fixtureConfig(planning);
  const commands = o.commands ?? { test: "node --test", lint: "node --check src/todos.js" };
  const project = ProjectConfig.parse({ id: "p", name: "P", repository: repo, linear: { teamKey: "JAM" }, github: { repo: "Nikorag/todo" }, commands, overrides: o.projectPasses ? { maxImplementationPasses: o.projectPasses } : undefined });
  const r = (provider: string, model: string) => ({ provider, model });
  const config: LoadedConfig = {
    ...base, factory: { ...base.factory, dataDir: join(repo, "..", "data"), ...(o.passes ? { maxImplementationPasses: o.passes } : {}), workflow: { ...base.factory.workflow, ...(o.maxConflicts !== undefined ? { max_conflict_resolutions: o.maxConflicts } : {}) } }, projects: { projects: [project] },
    models: ModelsConfig.parse({ routes: { classification: r("anthropic", "haiku"), specification: r("anthropic", "default"), implementation: r("anthropic", "default"), independent_review: o.noReviewer ? undefined : r("anthropic", "haiku"), final_review: r("anthropic", "default") } }),
  };
  let virtualCalls = 0; // a virtual clock for delivery waits: each reading is clockStepMs later, independent of how fast the machine is
  const github = o.github ?? new FakeGitHub(); // ALWAYS a fake: a test must never reach the real GitHub
  const claude = new ImplAgent("anthropic");
  const haiku = claude; // one scripted agent serves both Claude routes; assertions distinguish by req.model
  const linear = new FakeLinear();
  const issue = linear.addIssue({ key: "JAM-1", team: "JAM" }); issue.title = TITLE;
  const ctx = createContext(config, { db: openDb(":memory:"), logger: pino({ level: "silent" }), linear, agents: { anthropic: claude, local: claude }, github, deliveryNow: o.now ?? (o.clockStepMs ? (() => new Date(Date.now() + (virtualCalls++) * o.clockStepMs!)) : undefined), delivery: { ciPollMs: 5, noCiGraceMs: 0, ciMaxMs: 60_000, mergePollMs: 600_000, mergeMaxMs: 3_600_000, ...o.timing } });
  ctx.handle.db.update(projects).set({ validationJson: JSON.stringify({ ok: true }) }).run();
  const jobId = enqueue(ctx.handle.db, { projectId: "p", externalId: issue.id, externalKey: "JAM-1" }).job.id;
  // Arrive at IMPLEMENTATION_PREPARATION the way a real job does: worktree on factory/JAM-1 with the committed spec.
  const info = await ctx.worktrees.create({ id: jobId, projectId: "p", externalKey: "JAM-1" });
  if (planning === "speckit") {
    const dir = featureDirFor("JAM-1", TITLE);
    for (const f of SPEC_FILES) write(info.path, `${dir}/${f}`, fixture(f));
    write(info.path, `${dir}/ticket.md`, `# JAM-1: ${TITLE}\n`);
    await commitPaths(info.path, [dir], "spec(JAM-1): all");
    ctx.handle.db.update(jobs).set({ stage: "IMPLEMENTATION_PREPARATION" }).where(eq(jobs.id, jobId)).run();
  } else {
    ctx.handle.db.update(jobs).set({ stage: "REQUIREMENTS_ANALYSIS" }).where(eq(jobs.id, jobId)).run(); // the first stage that differs: Haiku writes the prompt
  }
  const engine = new Engine({ db: ctx.handle.db, logger: pino({ level: "silent" }), config, handlers: ctx.handlers, backoffBaseMs: 0, observer: createLinearReporter(ctx.handle.db), ...(o.now ? { now: o.now } : {}) });
  const hist = () => ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, jobId)).all().map((x) => `${x.stage}:${x.outcome}`);
  return { github, linear, ctx, claude, haiku, repo, jobId, engine, wt: info.path, hist, stages: () => hist().map((h) => h.split(":")[0]!) };
}
export const job = (h: H) => getJob(h.ctx.handle.db, h.jobId)!;
export const decisionKinds = (h: H) => h.ctx.handle.db.select().from(decisions).all().map((d) => d.kind);
export const impl = (h: H) => h.claude.calls.filter((c) => c.role === "implementer");

