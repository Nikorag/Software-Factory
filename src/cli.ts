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

const openFactoryDb = () => {
  const config = loadConfig();
  return { config, handle: openDb(join(config.factory.dataDir, "database", "factory.sqlite")) };
};
const ACTOR = "cli";

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
