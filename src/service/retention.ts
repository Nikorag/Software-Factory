import { copyFileSync, lstatSync, readdirSync, renameSync, rmdirSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Deletes per-job logs (agent runs under logs/agents, project commands under logs/commands) (and their emptied folders) older than `days`. Returns how many files were removed. Never touches anything outside `logDir`. */
export function pruneAgentLogs(logDir: string, days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the log directory
      if (e.isDirectory()) { walk(p); try { rmdirSync(p); } catch { /* not empty */ } }
      else if (statSync(p).mtimeMs < cutoff) { try { unlinkSync(p); removed++; } catch { /* in use */ } }
    }
  };
  walk(logDir);
  return removed;
}

/** The long-lived logs a service writes to forever: its own pino log, and the stdout/stderr files of `start` and the LaunchAgent. */
export const SERVICE_LOGS = ["factory.log", "service.out", "launchd.out.log", "launchd.err.log"];
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_ROTATE_KEEP = 3;

/**
 * Size-based rotation: a file over `maxBytes` becomes `<file>.1` (older copies shift to .2 ... .keep, the oldest is dropped).
 * Copy-then-truncate rather than rename, because the writers (pino, and the stdout/stderr our parent process or launchd opened in
 * append mode) keep their file descriptor: after truncation they carry on at the start of the same, now empty, file. A few lines
 * written between the copy and the truncate can be lost; that is acceptable for these logs. Returns the files rotated.
 */
export function rotateLogs(dir: string, names: string[] = SERVICE_LOGS, maxBytes = LOG_ROTATE_BYTES, keep = LOG_ROTATE_KEEP): string[] {
  const rotated: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size <= maxBytes) continue; // also never follows a symlink
      try { unlinkSync(`${file}.${keep}`); } catch { /* none yet */ }
      for (let i = keep - 1; i >= 1; i--) { try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* none yet */ } }
      if (keep > 0) copyFileSync(file, `${file}.1`);
      truncateSync(file, 0);
      rotated.push(name);
    } catch { /* missing or in use: try again next time */ }
  }
  return rotated;
}
