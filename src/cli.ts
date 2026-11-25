import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config/load.js";
import { openDb } from "./db/client.js";
import { runDoctor } from "./doctor/checks.js";
import { createLogger } from "./logging/logger.js";
import { buildServer } from "./server/app.js";
import { cancelJob, listJobs, retryJob } from "./core/jobs.js";
import * as control from "./core/control.js";
import { runSimulation } from "./core/simulation.js";
import { syncProjects, validateProjects } from "./repo/registry.js";
import { ensureClone } from "./repo/clone.js";
import { createLinearClient, type LinearClient } from "./linear/client.js";
import { discoverIssues } from "./linear/discovery.js";
import { flushOutbox } from "./linear/outbox.js";
import { createContext } from "./app/context.js";
import { onboardProject } from "./speckit/onboard.js";

const openFactoryDb = () => {
  const config = loadConfig();
  return { config, handle: openDb(join(config.factory.dataDir, "database", "factory.sqlite")) };
};
const ACTOR = "cli";
const linearClient = (config: ReturnType<typeof loadConfig>): LinearClient => {
  const key = process.env[config.linear.apiKeyEnv];
  if (!key) throw new Error(`${config.linear.apiKeyEnv} is not set`);
  return createLinearClient({ apiKey: key });
};

const program = new Command("factory").description("Local-first autonomous software factory");

program
  .command("doctor")
  .description("Audit the environment and integrations (read-only)")
  .action(async () => {
    const results = await runDoctor(loadConfig());
    const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
    for (const r of results) console.log(`${icon[r.status]} ${r.name.padEnd(20)} ${r.detail}`);
    process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
  });

program
  .command("config:check")
  .description("Validate configuration files")
  .action(() => {
    const c = loadConfig();
    console.log(`OK: ${c.projects.projects.length} project(s), dataDir=${c.factory.dataDir}`);
  });

program
  .command("simulate")
  .description("Run a simulated job through every stage in an in-memory database (no side effects)")
  .option("--dry-run", "exercise dry-run behaviour (mutating stages are skipped)")
  .action(async (opts: { dryRun?: boolean }) => {
    const { history } = await runSimulation(loadConfig(), Boolean(opts.dryRun));
    console.log(history.join("\n"));
  });

program.command("jobs").description("List jobs").action(() => {
  const { handle } = openFactoryDb();
  for (const j of listJobs(handle.db)) console.log(`${j.id.slice(0, 8)}  ${j.externalKey.padEnd(10)} ${j.status.padEnd(9)} ${j.stage}${j.lastError ? `  (${j.lastError})` : ""}`);
  handle.close();
});
program.command("job:cancel <id>").description("Cancel a job").action((id: string) => {
  const { handle } = openFactoryDb(); console.log(cancelJob(handle.db, id, ACTOR).status); handle.close();
});
program.command("job:retry <id>").description("Retry a failed or held job").action((id: string) => {
  const { handle } = openFactoryDb(); console.log(retryJob(handle.db, id, ACTOR).stage); handle.close();
});
for (const [name, fn] of [["pause", control.pause], ["resume", control.resume], ["stop", control.emergencyStop], ["clear-stop", control.clearEmergencyStop]] as const) {
  program.command(name).description(`Control: ${name}`).action(() => {
    const { handle } = openFactoryDb(); (fn as (d: typeof handle.db, a: string) => void)(handle.db, ACTOR); console.log(`${name}: ok`); handle.close();
  });
}

program
  .command("project:sync [id]")
  .description("Clone any factory-managed repositories that are missing (never touches existing checkouts)")
  .action(async (id: string | undefined) => {
    const config = loadConfig();
    const selected = config.projects.projects.filter((p) => p.enabled && (!id || p.id === id));
    let failed = 0;
    for (const p of selected) {
      const r = await ensureClone(p);
      if (r.status === "error") failed++;
      console.log(`${r.status === "error" ? "✗" : "✓"} ${p.id.padEnd(18)} ${r.status}${"path" in r ? `  ${r.path}` : ""}${"reason" in r ? `  (${r.reason})` : ""}${"error" in r ? `  ${r.error}` : ""}`);
    }
    process.exitCode = failed ? 1 : 0;
  });

program
  .command("project:validate [id]")
  .description("Inspect enrolled repositories (read-only) and record the result")
  .option("--json", "print full JSON reports")
  .action(async (id: string | undefined, opts: { json?: boolean }) => {
    const { config, handle } = openFactoryDb();
    const selected = config.projects.projects.filter((p) => !id || p.id === id);
    if (selected.length === 0) { console.error(id ? `no such project: ${id}` : "no projects configured in config/projects.yaml"); process.exitCode = 1; handle.close(); return; }
    syncProjects(handle.db, config.projects.projects);
    const reports = await validateProjects(handle.db, selected);
    for (const r of reports) {
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); continue; }
      console.log(`${r.ok ? "✓" : "✗"} ${r.projectId}  ${r.path}  (default: ${r.defaultBranch ?? "?"}, build: ${r.buildSystems.join(",") || "none"}, protection: ${r.branchProtection.status})`);
      for (const f of r.findings) console.log(`    ${f.severity.padEnd(5)} ${f.code}: ${f.message}`);
    }
    process.exitCode = reports.every((r) => r.ok) ? 0 : 1;
    handle.close();
  });

program
  .command("linear:check")
  .description("Read-only: verify the Linear key and that every configured status and label exists for each bound team")
  .action(async () => {
    const config = loadConfig();
    const client = linearClient(config);
    console.log(`✓ authenticated as ${(await client.viewer()).name}`);
    const teams = await client.teams();
    const keys = [...new Set(config.projects.projects.flatMap((p) => (p.linear ? [p.linear.teamKey] : [])))];
    if (keys.length === 0) {
      console.log("! no projects are bound to a Linear team (set `linear.teamKey` in config/projects.yaml). Teams visible to this key:");
      for (const t of teams) console.log(`    ${t.key}  ${t.name}`);
    }
    for (const t of teams.filter((t) => keys.length === 0 || keys.includes(t.key))) {
      const ps = await client.projects(t.id);
      console.log(`  Linear projects in ${t.key}: ${ps.length ? "" : "(none)"}`);
      for (const p of ps) console.log(`    ${p.name}  [${p.id}]`);
    }
    let missing = 0;
    for (const key of keys) {
      const team = teams.find((t) => t.key === key);
      if (!team) { console.log(`✗ team ${key} not found or not visible to this key`); missing++; continue; }
      const states = (await client.workflowStates(team.id)).map((s) => s.name.toLowerCase());
      const labels = (await client.labels(team.id)).map((l) => l.name.toLowerCase());
      for (const n of Object.values(config.linear.statuses)) if (!states.includes(n.toLowerCase())) { console.log(`✗ ${key}: status "${n}" missing`); missing++; }
      for (const n of Object.values(config.linear.labels)) if (!labels.includes(n.toLowerCase())) { console.log(`✗ ${key}: label "${n}" missing`); missing++; }
      console.log(`${missing ? "!" : "✓"} team ${key} checked`);
    }
    process.exitCode = missing ? 1 : 0;
  });

program
  .command("linear:discover")
  .description("Poll Linear once and create jobs for eligible issues")
  .option("--dry-run", "report what would be created without writing jobs' Linear updates")
  .action(async (opts: { dryRun?: boolean }) => {
    const { config, handle } = openFactoryDb();
    syncProjects(handle.db, config.projects.projects);
    const logger = createLogger({ level: "warn" });
    const r = await discoverIssues({ db: handle.db, client: linearClient(config), linear: config.linear, projects: config.projects.projects, logger, dryRun: opts.dryRun || config.factory.dryRun });
    for (const e of r.enqueued) console.log(`+ ${e.key} -> ${e.projectId} (${e.workflow}${e.autonomous ? ", autonomous" : ""})`);
    for (const s of r.skipped) console.log(`- ${s.key}: ${s.reasons.join("; ")}`);
    for (const e of r.errors) console.log(`! ${e.projectId}: ${e.error}`);
    handle.close();
  });

program
  .command("linear:flush")
  .description("Send pending Linear writes (status changes, labels, comments)")
  .action(async () => {
    const { config, handle } = openFactoryDb();
    if (config.factory.dryRun) { console.log("dry-run: not sending"); handle.close(); return; }
    console.log(await flushOutbox({ db: handle.db, client: linearClient(config), linear: config.linear, logger: createLogger({ level: "warn" }) }));
    handle.close();
  });

program
  .command("project:onboard <id>")
  .description("Add Spec Kit and an evidence-based constitution to a project on a local review branch (never pushes, never overwrites)")
  .action(async (id: string) => {
    const config = loadConfig();
    const project = config.projects.projects.find((p) => p.id === id);
    if (!project) { console.error(`no such project: ${id}`); process.exitCode = 1; return; }
    const ctx = createContext(config);
    const r = await onboardProject(project, { runner: ctx.runner, dataDir: config.factory.dataDir });
    console.log(r.status === "already-initialised" ? `${id}: Spec Kit is already set up` : `${id}: created branch ${r.branch} (${r.commits.join(", ")})\n  review: git -C ${r.worktree} log -p ${project.defaultBranch}..HEAD`);
    ctx.handle.close();
  });

program
  .command("work")
  .description("Run claimable jobs through the factory once (uses real agents and your Claude subscription)")
  .option("--dry-run", "plan only: skip every mutating stage")
  .action(async (opts: { dryRun?: boolean }) => {
    const config = loadConfig();
    if (opts.dryRun) config.factory.dryRun = true;
    const ctx = createContext(config);
    let ran = 0;
    for (let n = await ctx.engine.tick(); n > 0; n = await ctx.engine.tick()) ran += n;
    console.log(`ran ${ran} job(s)`);
    for (const j of listJobs(ctx.handle.db)) console.log(`${j.id.slice(0, 8)}  ${j.externalKey.padEnd(10)} ${j.status.padEnd(9)} ${j.stage}${j.lastError ? `\n    ${j.lastError.split("\n")[0]}` : ""}`);
    ctx.handle.close();
  });

program
  .command("serve")
  .description("Start the factory service (loopback only)")
  .action(async () => {
    const config = loadConfig();
    const logger = createLogger({ level: config.factory.logLevel, file: join(config.factory.dataDir, "logs", "factory.log") });
    const handle = openDb(join(config.factory.dataDir, "database", "factory.sqlite"));
    const app = buildServer({ db: handle.db, logger });
    const shutdown = async () => { await app.close(); handle.close(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await app.listen({ host: config.factory.server.host, port: config.factory.server.port });
  });

await program.parseAsync();
