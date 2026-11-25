import { execFileSync } from "node:child_process";

/**
 * Process identity. A bare pid is not an identity: after a crash or a reboot the number is reused by an unrelated process.
 * A pid together with its start time is (ps reports it to the second, and a pid cannot be reused within the same second it
 * was handed out while that process lives), so anything we might signal later is recorded as {pid, start} and checked first.
 */
export interface ProcessRecord { pid: number; start: string | null }

const ps = (args: string[]): string | null => {
  try {
    // LC_ALL=C: lstart is locale-formatted, and we compare and parse it.
    return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
  } catch { return null; } // ps exits 1 when the pid does not exist
};

export const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** When a process started (ps `lstart`, e.g. "Wed Nov 25 21:29:19 2026"), or null if there is no such process. */
export function startTimeOf(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const s = ps(["-o", "lstart=", "-p", String(pid)])?.trim();
  return s ? s.replace(/\s+/g, " ") : null;
}

/** The full command line of a process, or null if there is no such process. */
export function commandOf(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const s = ps(["-o", "command=", "-p", String(pid)])?.trim();
  return s || null;
}

export const identify = (pid: number): ProcessRecord => ({ pid, start: startTimeOf(pid) });

/** Is the process this record was taken from still running (same pid AND same start time)? A record without a start time never matches. */
export function stillRunning(r: ProcessRecord): boolean {
  if (!r.start || !alive(r.pid)) return false;
  return startTimeOf(r.pid) === r.start;
}

/** Does this command line look like a factory service (`… cli.js|cli.ts … serve`)? Only used for lock files written by older versions, which hold a bare pid. */
export const looksLikeFactory = (cmd: string | null): boolean => !!cmd && /\bserve\b/.test(cmd) && /(software-factory|\bcli\.(js|ts)\b)/.test(cmd);

export interface PsRow { pid: number; pgid: number; start: string }

/** Every process in a process group, with its start time. */
export function groupMembers(pgid: number): PsRow[] {
  const out = ps(["-A", "-o", "pid=,pgid=,lstart="]);
  if (!out) return [];
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && Number(m[2]) === pgid) rows.push({ pid: Number(m[1]), pgid, start: m[3]!.replace(/\s+/g, " ") });
  }
  return rows;
}

/** lstart as epoch ms (NaN if it cannot be parsed: callers then refuse to act). */
export const startMs = (lstart: string): number => Date.parse(lstart);
