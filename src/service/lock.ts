import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export class LockHeldError extends Error {
  constructor(readonly pid: number, file: string) {
    super(`another factory service is already running (pid ${pid}, lock ${file}). Stop it first (e.g. \`launchctl bootout\` or kill ${pid}).`);
    this.name = "LockHeldError";
  }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** One service per data directory: two would claim, run and flush the same jobs. A stale lock (dead pid) is taken over. */
export function acquireLock(file: string, pid = process.pid): { release(): void } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600); // exclusive create: atomic
      writeSync(fd, String(pid));
      closeSync(fd);
      return { release: () => { try { if (Number(readFileSync(file, "utf8")) === pid) rmSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) throw new LockHeldError(holder, file);
      rmSync(file, { force: true }); // stale (or our own leftover): take over and retry
    }
  }
  throw new Error(`could not acquire ${file}`);
}
