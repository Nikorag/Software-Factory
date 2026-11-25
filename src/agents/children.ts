import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupMembers, identify, startMs, startTimeOf, stillRunning, type ProcessRecord } from "../service/proc.js";

/**
 * Every child process group runProcess starts (agents, test suites, Spec Kit, git hooks...), so none can outlive the service.
 *
 * In memory: the live groups, so a shutdown can wait for them and kill stragglers, and a crash or process.exit can SIGKILL them.
 * On disk (only when the service has set a pid dir): one file per group, `<pgid>.json` = {pgid, start, owner}, so groups left
 * behind by a service that died without cleaning up (SIGKILL, a launchd exit timeout, a power cut) are found and killed at the
 * next start, before crash recovery re-runs a stage in the worktree an orphan is still editing.
 */
export interface ChildRecord { pgid: number; start: string; owner: ProcessRecord; cmd?: string }

const live = new Set<number>();
let pidDir: string | null = null;
let owner: ProcessRecord | null = null;

/** Where to record child groups (the service sets `<dataDir>/run/agents`); null stops recording (tests, one-off CLI commands). */
export function setChildPidDir(dir: string | null): void {
  pidDir = dir;
  if (dir) { mkdirSync(dir, { recursive: true }); owner = identify(process.pid); }
}

/** Register a freshly spawned group leader (spawned with detached: true, so its pgid is its pid). Returns the unregister function. */
export function trackChild(pid: number, cmd?: string): () => void {
  live.add(pid);
  let file: string | null = null;
  if (pidDir && owner) {
    const start = startTimeOf(pid);
    if (start) {
      file = join(pidDir, `${pid}.json`);
      try { writeFileSync(file, JSON.stringify({ pgid: pid, start, owner, cmd } satisfies ChildRecord), { mode: 0o600 }); } catch { file = null; }
    }
  }
  return () => { live.delete(pid); if (file) rmSync(file, { force: true }); };
}

export const liveChildren = (): number[] => [...live];

const killGroup = (pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* gone */ } };
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Signal every live child group (synchronous: safe in an "exit" handler). */
export function killAllChildren(sig: NodeJS.Signals = "SIGKILL"): number {
  for (const g of live) killGroup(g, sig);
  return live.size;
}

/**
 * The end of a shutdown: wait (bounded) for every child group to go, then SIGKILL whatever is left and wait briefly for that.
 * Returns how many groups had to be killed.
 */
export async function drainChildren(graceMs = 10_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  const until = Date.now() + graceMs;
  while (Date.now() < until && [...live].some(groupAlive)) await sleep(100);
  const left = [...live].filter(groupAlive);
  for (const g of left) killGroup(g, "SIGKILL");
  const hard = Date.now() + 2000;
  while (Date.now() < hard && left.some(groupAlive)) await sleep(50);
  return left.length;
}

/**
 * Which processes of a recorded group are verifiably ours. The leader must still have its recorded start time; if the leader
 * has gone, its group can live on in its children, and those must have started no earlier than the leader did (a process
 * that predates the record cannot be one of its descendants). Anything else (a reused pid, a parse failure) is left alone.
 */
export function verifiedGroup(r: ChildRecord, members = groupMembers(r.pgid)): number[] {
  if (members.length === 0) return [];
  const leader = members.find((m) => m.pid === r.pgid);
  if (leader) return leader.start === r.start ? members.map((m) => m.pid) : [];
  const t0 = startMs(r.start);
  if (Number.isNaN(t0)) return [];
  return members.every((m) => !Number.isNaN(startMs(m.start)) && startMs(m.start) >= t0) ? members.map((m) => m.pid) : [];
}

export interface ReapReport { killed: number[]; skipped: number[] }

/**
 * At service start (and after a forced stop): kill the process groups a previous service left behind. Each record is checked
 * (see verifiedGroup) so a reused pid is never signalled, and records of a still-running owner other than us are left alone.
 */
export async function reapOrphans(dir: string, opts: { graceMs?: number; self?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<ReapReport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const self = opts.self ?? process.pid;
  const report: ReapReport = { killed: [], skipped: [] };
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return report; }
  const targets: { file: string; pgid: number }[] = [];
  for (const f of files) {
    const file = join(dir, f);
    let r: ChildRecord;
    try { r = JSON.parse(readFileSync(file, "utf8")) as ChildRecord; } catch { rmSync(file, { force: true }); continue; }
    if (!Number.isInteger(r.pgid) || r.pgid <= 1 || typeof r.start !== "string") { rmSync(file, { force: true }); continue; }
    if (r.owner && r.owner.pid !== self && stillRunning(r.owner)) { report.skipped.push(r.pgid); continue; } // its service is alive: not an orphan
    if (r.owner?.pid === self && live.has(r.pgid)) continue; // one of ours, running now
    const pids = verifiedGroup(r);
    if (pids.length === 0) { rmSync(file, { force: true }); continue; } // gone, or the pid is someone else's now
    killGroup(r.pgid, "SIGTERM");
    targets.push({ file, pgid: r.pgid });
  }
  const until = Date.now() + (opts.graceMs ?? 3000);
  while (Date.now() < until && targets.some((t) => groupAlive(t.pgid))) await sleep(100);
  for (const t of targets) {
    if (groupAlive(t.pgid)) killGroup(t.pgid, "SIGKILL");
    rmSync(t.file, { force: true });
    report.killed.push(t.pgid);
  }
  return report;
}

/**
 * For the service process: whatever ends it, its children go with it. An uncaught exception or unhandled rejection is logged,
 * every child group is SIGKILLed and the process exits 1 (so launchd restarts it). Any exit, including a process.exit()
 * anywhere, SIGKILLs groups still alive (the "exit" handler is synchronous, which process.kill is).
 */
export function installCrashHandlers(report: (kind: string, err: unknown) => void, exit: (code: number) => void = (c) => process.exit(c)): () => void {
  const crash = (kind: string) => (err: unknown) => {
    try { report(kind, err); } catch { /* reporting must not stop the cleanup */ }
    killAllChildren("SIGKILL");
    exit(1);
  };
  const onException = crash("uncaughtException"), onRejection = crash("unhandledRejection");
  const onExit = () => { killAllChildren("SIGKILL"); };
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  process.on("exit", onExit);
  return () => { process.off("uncaughtException", onException); process.off("unhandledRejection", onRejection); process.off("exit", onExit); };
}

/**
 * The service's answer to SIGINT/SIGTERM (and to the control API's shutdown). The first request stops gracefully. A second
 * signal while that is under way escalates instead of exiting half-way: running agents are SIGKILLed so the stop finishes
 * now. A third exits immediately (the "exit" handler still SIGKILLs any child). An API request never escalates.
 */
export function shutdownController(stop: (reason: string) => Promise<void>, o: { exit?: (code: number) => void; log?: (msg: string) => void } = {}) {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const log = o.log ?? ((m: string) => console.error(m));
  let requests = 0;
  return async (reason: string, escalate = true): Promise<void> => {
    if (requests > 0) {
      if (!escalate) return;
      requests++;
      if (requests === 2) { log(`${reason} again: killing running agents now so the stop can finish (once more to exit at once)`); killAllChildren("SIGKILL"); return; }
      log(`${reason} a third time: exiting now`); exit(0); return; // still a requested stop: exit 0 so launchd does not restart it
    }
    requests = 1;
    let code = 0;
    try { await stop(reason); } catch (e) { log(`shutdown failed: ${(e as Error).message}`); killAllChildren("SIGKILL"); code = 1; }
    exit(code);
  };
}
