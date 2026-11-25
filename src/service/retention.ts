import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Deletes agent run logs (and their emptied folders) older than `days`. Returns how many files were removed. Never touches anything outside `logDir`. */
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
