import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { expandHome } from "../config/load.js";
import { DEFAULT_PROFILE, type Profile } from "../config/profiles.js";
import type { UpdatePlan } from "./update.js";

/** Everything `runUpdate` touches outside the install, injectable so the sequence can be tested without real services. */
export interface UpdateDeps {
  profiles(): Profile[];
  isUp(p: Profile): Promise<boolean>;
  runningJobs(p: Profile): Promise<number>;
  stop(p: Profile): Promise<unknown>;
  start(p: Profile): Promise<{ started: boolean; error?: string }>;
  /**
   * A profile's LaunchAgent (one per profile). There is no separate "stop": `stop(p)` is the same verified stop as `shutdown`
   * (it boots this install's LaunchAgent out, so launchd does not restart old code mid-update).
   */
  agent: { loaded(p: Profile): boolean; refresh(p: Profile, load: boolean): { installed: boolean } };
  /** copies a profile's database aside; returns the backup's path, or null if it has no database yet */
  backup(p: Profile, tag: string): Promise<string | null>;
  apply(plan: UpdatePlan): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface RunUpdateOptions { /** wait for running jobs to finish instead of refusing */ wait?: boolean; /** update even while jobs run (their stage is redone) */ force?: boolean; waitTimeoutMs?: number; pollMs?: number }

export class UpdateRefused extends Error {}

/**
 * The whole of `software-factory update`, in the only safe order: make sure no job is mid-stage (refuse, wait, or --force), stop every
 * running profile (and the LaunchAgent) so no service keeps running old code against a database the new code migrates, back up each
 * profile's database, apply the update (which rolls itself back on failure), then re-render the LaunchAgent and restart exactly what was
 * running before, whether the update succeeded or not.
 */
export async function runUpdate(plan: UpdatePlan, o: RunUpdateOptions, d: UpdateDeps): Promise<{ restarted: string[] }> {
  const profiles = d.profiles();
  const up: Profile[] = [];
  for (const p of profiles) if (await d.isUp(p)) up.push(p);
  const busy = async () => { let n = 0; for (const p of up) n += await d.runningJobs(p); return n; };

  let running = await busy();
  if (running > 0 && !o.force) {
    if (!o.wait) throw new UpdateRefused(`${running} job(s) are running right now. Updating restarts the factory, which redoes the stage in progress. Run \`software-factory update --wait\` to update as soon as they finish, or --force to update now.`);
    const until = Date.now() + (o.waitTimeoutMs ?? 6 * 3600_000);
    while (running > 0) {
      if (Date.now() > until) throw new UpdateRefused(`gave up waiting: ${running} job(s) are still running. Nothing was changed.`);
      d.log(`waiting for ${running} running job(s) to finish…`);
      await d.sleep(o.pollMs ?? 15_000);
      running = await busy();
    }
  } else if (running > 0) d.log(`--force: ${running} running job(s) will be stopped and their stage redone after the update`);

  const underLaunchd = new Set(profiles.filter((p) => d.agent.loaded(p)).map((p) => p.name));
  const toStop = profiles.filter((p) => underLaunchd.has(p.name) || up.includes(p));
  if (toStop.length) d.log(`stopping the factory (${toStop.map((p) => p.name).join(", ")}) for the update…`);
  for (const p of toStop) await d.stop(p);

  const restarted: string[] = [];
  try {
    for (const p of profiles) { const f = await d.backup(p, plan.currentSha.slice(0, 7)); if (f) d.log(`backed up ${p.name}'s database to ${f}`); }
    await d.apply(plan);
  } finally {
    // With whatever code is installed now: the new version, or the old one after a rollback. Every installed LaunchAgent is
    // re-rendered; the ones that were loaded are loaded again, and launchd restarts their profiles.
    for (const p of profiles) {
      try { if (d.agent.refresh(p, underLaunchd.has(p.name)).installed && underLaunchd.has(p.name)) restarted.push(p.name); }
      catch (e) { d.log(`could not refresh ${p.name}'s LaunchAgent (${(e as Error).message}); reinstall it with \`software-factory${p.name === DEFAULT_PROFILE ? "" : ` --profile ${p.name}`} launchd:install --load\``); }
    }
    for (const p of up) {
      if (restarted.includes(p.name)) continue;
      const r = await d.start(p).catch((e: Error) => ({ started: false, error: e.message }));
      if (r.error) d.log(`could not restart ${p.name}: ${r.error}`); else restarted.push(p.name);
    }
  }
  return { restarted };
}

/** Where a profile's database is: <dataDir>/database/factory.sqlite, dataDir being the profile's home unless its factory.yaml says otherwise. */
export function profileDbFile(p: Profile): string {
  let dataDir = p.home;
  try {
    const set = (parse(readFileSync(join(p.home, "config", "factory.yaml"), "utf8")) as { dataDir?: string } | null)?.dataDir;
    if (set && set !== "~/.software-factory") dataDir = expandHome(set);
  } catch { /* no config: the default */ }
  return join(dataDir, "database", "factory.sqlite");
}

/**
 * A consistent copy of a SQLite database (`VACUUM INTO`, safe with WAL) next to it in backups/, keeping the newest `keep`.
 * Taken before an update, because the new code may migrate the schema and there is no down-migration.
 */
export function backupDatabase(file: string, tag: string, keep = 5, now = new Date()): string | null {
  if (!existsSync(file)) return null;
  const dir = join(file, "..", "backups");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `factory-${now.toISOString().replace(/[:.]/g, "-")}-${tag.replace(/[^\w.-]/g, "")}.sqlite`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { db.prepare("VACUUM INTO ?").run(dest); } finally { db.close(); }
  const old = readdirSync(dir).filter((f) => /^factory-.*\.sqlite$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return dest;
}
