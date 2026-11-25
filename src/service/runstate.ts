import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Small runtime files under <dataDir>/run (no database: they must work when the service is gone).
 *  - agents/<pgid>.json: the process groups the service has started (see src/agents/children.ts)
 *  - stopped.json: written when a stop begins and removed at start. A service that is not answering and has no marker did
 *    not stop on purpose (it crashed or was killed), which is what the desktop app tells you about.
 */
export const agentPidDir = (dataDir: string) => join(dataDir, "run", "agents");
export const stopMarkerPath = (dataDir: string) => join(dataDir, "run", "stopped.json");

export function writeStopMarker(dataDir: string, reason: string): void {
  const f = stopMarkerPath(dataDir);
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), reason })); } catch { /* best effort */ }
}
export const clearStopMarker = (dataDir: string) => rmSync(stopMarkerPath(dataDir), { force: true });
export function readStopMarker(dataDir: string): { pid: number; at: string; reason: string } | null {
  try { return JSON.parse(readFileSync(stopMarkerPath(dataDir), "utf8")) as { pid: number; at: string; reason: string }; } catch { return null; }
}
