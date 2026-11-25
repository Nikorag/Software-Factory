import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config/load.js";
import { openDb } from "./db/client.js";
import { eq } from "drizzle-orm";
import { projects } from "./db/schema.js";
import { runDoctor } from "./doctor/checks.js";
import { createLogger } from "./logging/logger.js";
import { cancelJob, listJobs, retryJob } from "./core/jobs.js";
import * as control from "./core/control.js";
import { runSimulation } from "./core/simulation.js";
import { syncProjects, validateProjects } from "./repo/registry.js";
import { ensureClone } from "./repo/clone.js";
import { createLinearClient, type LinearClient } from "./linear/client.js";
import { discoverIssues } from "./linear/discovery.js";
import { auditTeam, SUGGESTED_STATUS_TYPE } from "./linear/check.js";
import { applySetup, planSetup } from "./linear/setup.js";
import { flushOutbox } from "./linear/outbox.js";
import { createContext } from "./app/context.js";
import { onboardProject, raiseOnboardingPr } from "./speckit/onboard.js";
import { checkProject } from "./repo/check.js";
import { createGhClient } from "./github/client.js";
import { resolveSecret } from "./service/secrets.js";
import { startService } from "./service/main.js";
import { loadOrCreateToken } from "./server/app.js";
import { applyUpdate, planUpdate } from "./service/update.js";
import { activateProfile, addProfile, DEFAULT_PROFILE, factoryRoot, getProfile, listProfiles, ProfileError, removeProfile } from "./config/profiles.js";
import { desktopEntry, isUp, openDesktop, pidOf, startService as launchService, stopService, urlOf } from "./service/launch.js";
import { agentStatus, installAgent, uninstallAgent } from "./service/launchd.js";

const openFactoryDb = () => {
  const config = loadConfig();
  return { config, handle: openDb(join(config.factory.dataDir, "database", "factory.sqlite")) };
};
const ACTOR = "cli";
const linearClient = (config: ReturnType<typeof loadConfig>): LinearClient => {
  const key = resolveSecret({ envName: config.linear.apiKeyEnv, keychainService: config.linear.keychainService });
  if (!key) throw new Error(`${config.linear.apiKeyEnv} is not set and no keychain entry "${config.linear.keychainService}" was found`);
  return createLinearClient({ apiKey: key });
};

const NOT_PER_PROFILE = new Set(["start", "shutdown", "status", "profile", "list", "add", "remove", "update"]);
const program = new Command("factory").description("Local-first autonomous software factory").version(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string, "-v, --version");

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
/** Ask a running service to act (so `stop` terminates agents immediately). Returns false if no service answers. */
async function viaService(config: ReturnType<typeof loadConfig>, name: string): Promise<boolean> {
  try {
    const token = loadOrCreateToken(config.factory.dataDir);
    const port = config.factory.server.port;
    const res = await fetch(`http://127.0.0.1:${port}/api/control/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}
for (const [name, fn] of [["pause", control.pause], ["resume", control.resume], ["stop", control.emergencyStop], ["clear-stop", control.clearEmergencyStop]] as const) {
  program.command(name).description(`Control: ${name} (applied by a running service immediately; otherwise recorded for the next start)`).action(async () => {
    const config = loadConfig();
    if (await viaService(config, name)) { console.log(`${name}: ok (applied by the running service)`); return; }
    const { handle } = openFactoryDb(); (fn as (d: typeof handle.db, a: string) => void)(handle.db, ACTOR);
    console.log(`${name}: ok (no service is running: recorded; it takes effect when the service starts)`); handle.close();
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
    let bad = 0;
    for (const key of keys) {
      const team = teams.find((t) => t.key === key);
      if (!team) { console.log(`✗ team ${key} not found or not visible to this key`); bad++; continue; }
      const a = await auditTeam(client, config.linear, team);
      const line = (g: { name: string; required: boolean }, what: string) => console.log(`  ${g.required ? "✗ REQUIRED" : "- optional"}  ${what} "${g.name}" is missing`);
      for (const g of a.statuses) line(g, "status");
      for (const g of a.labels) line(g, "label");
      if (!a.ok) bad++;
      console.log(`${a.ok ? "✓" : "✗"} team ${key}: ${a.ok ? "everything the factory writes today exists" : "required items missing"}`);
      if (a.statuses.length || a.labels.length) {
        console.log(`  existing statuses in ${key}: ${a.existingStatuses.join(", ")}`);
        console.log(`  suggested types when creating a status: ${a.statuses.map((g) => `${g.name} = ${SUGGESTED_STATUS_TYPE[g.key as keyof typeof SUGGESTED_STATUS_TYPE]}`).join("; ") || "-"}`);
      }
    }
    process.exitCode = bad ? 1 : 0;
  });

program
  .command("linear:setup")
  .description("Create the Linear statuses and labels the factory needs (dry run unless --apply; creates only, never edits or deletes)")
  .option("--apply", "actually create them (default: show the plan)")
  .option("--include-optional", "also create the optional labels/statuses (autonomous, bugfix, feature, maintenance, ...)")
  .action(async (opts: { apply?: boolean; includeOptional?: boolean }) => {
    const config = loadConfig();
    const client = linearClient(config);
    const teams = await client.teams();
    const keys = [...new Set(config.projects.projects.flatMap((p) => (p.linear ? [p.linear.teamKey] : [])))];
    for (const key of keys) {
      const team = teams.find((t) => t.key === key);
      if (!team) { console.log(`✗ team ${key} not found`); process.exitCode = 1; continue; }
      const plan = planSetup(await auditTeam(client, config.linear, team), { includeOptional: opts.includeOptional });
      if (plan.length === 0) { console.log(`✓ ${key}: nothing to create`); continue; }
      for (const a of plan) console.log(`  ${opts.apply ? "creating" : "would create"} ${a.kind} "${a.name}"${a.kind === "status" ? ` (type: ${a.type})` : ""} in team ${key}`);
      if (!opts.apply) { console.log(`  (dry run: re-run with --apply to create)`); continue; }
      const r = await applySetup(client, config.linear, team, { includeOptional: opts.includeOptional });
      for (const c of r.created) console.log(`  ✓ created ${c}`);
      for (const f of r.failed) { console.log(`  ✗ ${f.action}: ${f.error}`); process.exitCode = 1; }
    }
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
  .description("Add Spec Kit and an evidence-based constitution to a project on a local review branch (never overwrites). With --pr, also pushes the branch and opens a PR for review (never merges).")
  .option("--pr", "push factory/onboard-speckit and open a pull request for human review")
  .action(async (id: string, opts: { pr?: boolean }) => {
    const config = loadConfig();
    const project = config.projects.projects.find((p) => p.id === id);
    if (!project) { console.error(`no such project: ${id}`); process.exitCode = 1; return; }
    const ctx = createContext(config);
    const r = await onboardProject(project, { runner: ctx.runner, dataDir: config.factory.dataDir });
    console.log(r.status === "already-initialised" ? `${id}: Spec Kit is already set up` : `${id}: created branch ${r.branch} (${r.commits.join(", ")})\n  review: git -C ${r.worktree} log -p ${project.defaultBranch}..HEAD`);
    if (opts.pr) {
      const { pr, reused } = await raiseOnboardingPr(project, { github: createGhClient({ account: project.github.account }), worktree: r.worktree });
      console.log(`${reused ? "PR already open" : "PR raised"}: ${pr.url}  (not merged: a human reviews and merges it)`);
    }
    ctx.handle.close();
  });

program
  .command("project:check <id>")
  .description("Prove a project's install/build/lint/typecheck/test commands work: runs them in a throwaway worktree under the sandbox")
  .option("--no-install", "skip the install step (reuse nothing: only for projects that need no dependencies)")
  .option("--keep", "keep the throwaway worktree for inspection")
  .action(async (id: string, opts: { install: boolean; keep?: boolean }) => {
    const config = loadConfig();
    const project = config.projects.projects.find((p) => p.id === id);
    if (!project) { console.error(`no such project: ${id}`); process.exitCode = 1; return; }
    if (project.managed) { const c = await ensureClone(project); if (c.status === "error") { console.error(c.error); process.exitCode = 1; return; } }
    const report = await checkProject(project, {
      dataDir: config.factory.dataDir, sandbox: config.factory.sandbox, timeoutMs: config.factory.commandTimeoutSeconds * 1000, skipInstall: !opts.install, keep: opts.keep,
      onResult: (r) => console.log(`${r.ok ? "✓" : "✗"} ${r.kind.padEnd(9)} ${Math.round(r.durationMs / 1000)}s${r.sandboxed ? "" : " (UNSANDBOXED)"}  ${r.command}${r.ok ? "" : `\n${r.tail.slice(-1800).split("\n").map((l) => `    ${l}`).join("\n")}`}`),
    });
    { const { handle } = openFactoryDb(); syncProjects(handle.db, config.projects.projects); handle.db.update(projects).set({ checkJson: JSON.stringify({ ok: report.ok, at: Date.now(), missingTest: report.missingTest }) }).where(eq(projects.id, id)).run(); handle.close(); } // counts towards onboarding
    if (report.missingTest) console.log("! no `test` command is configured: the factory will not implement changes for this project");
    console.log(report.ok ? `\n✓ ${id}: all configured commands pass on ${report.baseRef}` : `\n✗ ${id}: not ready`);
    if (opts.keep) console.log(`  worktree kept at ${report.worktree}`);
    process.exitCode = report.ok ? 0 : 1;
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
  .option("-p, --profile <name>", "which profile to work with (default: the default profile; see `software-factory profile list`)")
  .hook("preAction", (_cmd, action) => {
    const name = program.opts<{ profile?: string }>().profile ?? process.env.FACTORY_PROFILE;
    if (name && !NOT_PER_PROFILE.has(action.name())) activateProfile(name);
  });

program
  .command("start", { isDefault: true })
  .description("Start every profile's factory in the background and open the app window. Returns immediately: the terminal is free. (This is what running `software-factory` alone does.)")
  .option("--no-window", "start the services only")
  .option("--browser", "open the dashboard in your browser instead of the app window")
  .action(async (opts: { window: boolean; browser?: boolean }) => {
    const root = factoryRoot();
    const chosen = getProfile(program.opts<{ profile?: string }>().profile ?? DEFAULT_PROFILE, root);
    for (const p of listProfiles(root)) {
      const r = await launchService(p, root);
      console.log(`${r.error ? "✗" : "✓"} ${p.name.padEnd(12)} ${r.error ?? (r.started ? `started  ${urlOf(p)}` : `already running  ${urlOf(p)}`)}`);
    }
    if (!opts.window) return;
    const first = listProfiles(root).length === 1 && !(await fetch(urlOf(chosen, "/api/setup")).then((r) => r.json()).then((j: { projectCount?: number }) => (j.projectCount ?? 0) > 0).catch(() => false));
    const hash = first ? "#/setup" : "";
    if (!opts.browser && process.platform === "darwin" && openDesktop(chosen, root)) { console.log("Opened the Software Factory window. It keeps running in the background; `software-factory shutdown` stops it."); return; }
    if (!desktopEntry() && !opts.browser) console.log("(The desktop app is not installed, so opening your browser instead.)");
    if (process.platform === "darwin") execFileSync("open", [urlOf(chosen, `/${hash}`)]);
    else console.log(`Open ${urlOf(chosen, `/${hash}`)}`);
  });

program
  .command("shutdown")
  .description("Shut down the background factory of every profile (or one with --profile). Running agents are aborted and their jobs re-queued untouched.")
  .action(async () => {
    const only = program.opts<{ profile?: string }>().profile;
    for (const p of listProfiles().filter((x) => !only || x.name === only)) console.log(`${p.name.padEnd(12)} ${await stopService(p)}`);
  });

program
  .command("status")
  .description("Is each profile's factory running, and what is it doing?")
  .action(async () => {
    for (const p of listProfiles()) {
      const up = await isUp(p);
      const o = up ? ((await fetch(urlOf(p, "/api/overview")).then((r) => r.json()).catch(() => null)) as { counts?: { byStatus?: Record<string, number> } } | null) : null;
      const c = o?.counts?.byStatus ?? {};
      console.log(`${up ? "●" : "○"} ${p.name.padEnd(12)} ${up ? `running (pid ${pidOf(p) ?? "?"})  ${urlOf(p)}  jobs: ${c.running ?? 0} running, ${c.queued ?? 0} queued, ${c.waiting ?? 0} waiting` : "stopped"}`);
    }
  });

const profile = program.command("profile").description("Separate, isolated setups (e.g. home and work): each has its own projects, Linear, GitHub account, data and port");
profile.command("list").description("List profiles").action(() => { for (const p of listProfiles()) console.log(`${p.name.padEnd(12)} port ${p.port}  ${p.home}`); });
profile.command("add <name>").description("Create a profile").action((name: string) => {
  try { const p = addProfile(name); console.log(`created "${p.name}" (port ${p.port}). Run \`software-factory start\` and switch to it in the app; its setup wizard will ask for its own Linear key and projects.`); }
  catch (e) { if (e instanceof ProfileError) { console.error(e.message); process.exitCode = 1; } else throw e; }
});
profile.command("remove <name>").description("Forget a profile (its data stays on disk)").action(async (name: string) => {
  try {
    const p = getProfile(name);
    if (await isUp(p)) { console.error(`"${name}" is running: stop it first (software-factory shutdown --profile ${name})`); process.exitCode = 1; return; }
    removeProfile(name); console.log(`removed "${name}". Its data is still in ${p.home} (delete it yourself if you want it gone).`);
  } catch (e) { if (e instanceof ProfileError) { console.error(e.message); process.exitCode = 1; } else throw e; }
});

program
  .command("serve")
  .description("Run ONE profile's factory in the foreground (for debugging; `start` runs them all in the background)")
  .option("--no-scheduler", "dashboard and API only; do not poll Linear or run jobs")
  .option("--dry-run", "discover and plan only: skip every mutating stage")
  .option("--open", "open the dashboard in your browser (the setup wizard on first run)")
  .action(async (opts: { scheduler: boolean; dryRun?: boolean; open?: boolean }) => {
    const config = loadConfig();
    if (opts.dryRun) config.factory.dryRun = true;
    const svc = await startService(config, { scheduler: opts.scheduler });
    const url = `http://127.0.0.1:${svc.port}/${config.projects.projects.length === 0 ? "#/setup" : ""}`;
    console.log(`factory running on ${url}`);
    if (opts.open && process.platform === "darwin") execFileSync("open", [url]);
    if (config.factory.dryRun) console.log("DRY RUN: nothing will be changed in repositories, Linear or GitHub");
    const shutdown = async () => { await svc.stop(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("update")
  .description("Update this install to the newest release (or --ref <tag|branch>), reinstall dependencies and rebuild the dashboard. Your settings and data are never touched.")
  .option("--check", "only report whether an update is available")
  .option("--ref <ref>", "a release tag or branch instead of the newest release")
  .action(async (opts: { check?: boolean; ref?: string }) => {
    const plan = await planUpdate({ ref: opts.ref });
    const where = plan.targetIsTag ? `release ${plan.target}` : plan.target;
    if (plan.upToDate) { console.log(`up to date (${plan.current})`); return; }
    console.log(`${plan.current}  ->  ${where}  (${plan.behind} new commit(s))${plan.latestTag ? "" : "  [no releases yet: following main]"}`);
    if (opts.check) { console.log("run `software-factory update` to apply it"); return; }
    await applyUpdate(plan, { log: (l) => console.log(l) });
    console.log(`updated to ${where}.`);
    const config = loadConfig();
    try {
      const o = (await (await fetch(`http://127.0.0.1:${config.factory.server.port}/api/overview`, { signal: AbortSignal.timeout(2000) })).json()) as { counts: { byStatus: Record<string, number> } };
      const running = o.counts.byStatus.running ?? 0;
      console.log(`The factory is running and still has the old code. Restart it (software-factory shutdown, then software-factory) to use the update (${running ? `${running} job(s) are running right now: a restart redoes the stage in progress, so wait for a quiet moment` : "no jobs are running, so it is safe now"}).`);
    } catch { console.log("Start it with `software-factory`."); }
  });

program
  .command("dashboard")
  .description("Print the dashboard URL")
  .option("--open", "open it in the default browser")
  .action((opts: { open?: boolean }) => {
    const config = loadConfig();
    const url = `http://127.0.0.1:${config.factory.server.port}/`;
    console.log(url);
    if (opts.open) execFileSync("open", [url]);
  });

program
  .command("launchd:install")
  .description("Install the LaunchAgent. NOTE: once installed it starts automatically at every login (RunAtLoad); --load also starts it now.")
  .option("--load", "also load it now (starts the service, which polls Linear and runs jobs autonomously)")
  .action((opts: { load?: boolean }) => {
    const config = loadConfig();
    const r = installAgent({ dataDir: config.factory.dataDir, configDir: process.env.FACTORY_CONFIG_DIR ? resolve(process.env.FACTORY_CONFIG_DIR) : undefined, load: opts.load });
    console.log(`wrote ${r.path}`);
    console.log(r.loaded ? "loaded: the factory service is now running in the background and will start at every login" : "installed but not started now. It WILL start automatically at your next login. Start now: --load. Undo: pnpm factory launchd:uninstall");
  });
program.command("launchd:uninstall").description("Stop and remove the LaunchAgent").action(() => console.log(uninstallAgent().removed ? "removed" : "was not installed"));
program.command("launchd:status").description("Is the LaunchAgent installed and running?").action(() => console.log(JSON.stringify(agentStatus(), null, 2)));

await program.parseAsync();
