import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config/load.js";
import { openDb } from "./db/client.js";
import { runDoctor } from "./doctor/checks.js";
import { createLogger } from "./logging/logger.js";
import { buildServer } from "./server/app.js";

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
