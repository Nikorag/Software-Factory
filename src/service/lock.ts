import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { alive, commandOf, looksLikeFactory, startTimeOf, stillRunning, type ProcessRecord } from "./proc.js";

export class LockHeldError extends Error {
  constructor(readonly pid: number, file: string) {
    super(`another factory service is already running (pid ${pid}, lock ${file}). Stop it first (software-factory shutdown).`);
    this.name = "LockHeldError";
  }
}

/** What the lock file says. Current versions write {pid, start}; older ones wrote a bare pid (`legacy`). */
export interface LockRecord extends ProcessRecord { legacy?: boolean }

export function readLock(file: string): LockRecord | null {
  let text: string;
  try { text = readFileSync(file, "utf8").trim(); } catch { return null; }
  if (/^\d+$/.test(text)) { const pid = Number(text); return pid > 0 ? { pid, start: null, legacy: true } : null; }
  try {
    const j = JSON.parse(text) as { pid?: unknown; start?: unknown };
    if (typeof j.pid === "number" && Number.isInteger(j.pid) && j.pid > 0) return { pid: j.pid, start: typeof j.start === "string" ? j.start : null };
  } catch { /* garbage */ }
  return null;
}

/**
 * The pid of the live factory service holding this lock, or null. Never trusts a bare pid: after a crash or a reboot the
 * number may belong to an unrelated process, so the holder must have the recorded start time (or, for a lock written by an
 * older version, a factory command line). Only a pid returned from here may ever be signalled.
 */
export function lockHolder(file: string): number | null {
  const r = readLock(file);
  if (!r) return null;
  if (r.start) return stillRunning(r) ? r.pid : null;
  return alive(r.pid) && looksLikeFactory(commandOf(r.pid)) ? r.pid : null;
}

/** One service per data directory: two would claim, run and flush the same jobs. A stale lock (its process is gone, or the pid now belongs to something else) is taken over. */
export function acquireLock(file: string, pid = process.pid): { release(): void } {
  mkdirSync(dirname(file), { recursive: true });
  const me: ProcessRecord = { pid, start: startTimeOf(pid) };
  const tmp = `${file}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, file); // atomic, and the content is complete before anyone can read it
        return {
          release: () => {
            const r = readLock(file);
            if (r && r.pid === me.pid && r.start === me.start) rmSync(file, { force: true });
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = lockHolder(file);
        if (holder !== null && holder !== pid) throw new LockHeldError(holder, file);
        rmSync(file, { force: true }); // stale (or our own leftover): take over and retry
      }
    }
  } finally { rmSync(tmp, { force: true }); }
  throw new Error(`could not acquire ${file}`);
}
