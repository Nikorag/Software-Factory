import type { Job, Overview, Project } from "./types";
import { stageLabel } from "./format";

/** The redesign's status colours. Running = blue, needs you = amber, failed = red, queued = grey, done = green. */
export const TONE = { run: "#60A5FA", wait: "#FBBF24", fail: "#F87171", ok: "#4ADE80", queue: "#A1A1AA" } as const;

export type Bucket = "running" | "needs" | "queued";
const OPEN = new Set(["queued", "running", "waiting", "failed"]);

/** Jobs that deserve a tab: not finished, not archived. Finished work lives in the project's Overview tab. */
export function openJobs(o: Overview | null): Job[] {
  if (!o) return [];
  const seen = new Set<string>();
  return [...o.active, ...o.queued, ...o.recent].filter((j) => { if (seen.has(j.id) || !OPEN.has(j.status) || j.archivedAt) return false; seen.add(j.id); return true; });
}

export const bucketOf = (j: Job): Bucket => (j.status === "running" ? "running" : j.status === "queued" ? "queued" : "needs");
export const toneOf = (j: Job): string => ({ running: TONE.run, waiting: TONE.wait, failed: TONE.fail, queued: TONE.queue } as Record<string, string>)[j.status] ?? TONE.queue;
export const statusLabel = (j: Job): string => ({ running: "Running", waiting: "Needs you", failed: "Failed", queued: "Queued", done: "Done", cancelled: "Cancelled" } as Record<string, string>)[j.status] ?? j.status;

const SWATCHES = ["#A78BFA", "#2DD4BF", "#4ADE80", "#60A5FA", "#FB923C", "#F472B6", "#FBBF24", "#22D3EE"];
export const swatch = (id: string): string => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return SWATCHES[h % SWATCHES.length]!; };
export const initialOf = (p: Pick<Project, "name">): string => (p.name.trim()[0] ?? "?").toUpperCase();

/** The one-word state shown next to a project in the rail. */
export function projectMeta(jobs: Job[]): { text: string; color: string } {
  const n = (s: string) => jobs.filter((j) => j.status === s).length;
  if (n("failed")) return { text: "failed", color: TONE.fail };
  if (n("waiting")) return { text: "needs you", color: TONE.wait };
  if (n("running")) return { text: `${n("running")} running`, color: TONE.run };
  if (n("queued")) return { text: `${n("queued")} queued`, color: TONE.queue };
  return { text: "idle", color: "#8E8E98" };
}

export const stageName = (j: Job): string => stageLabel(j.status === "failed" && j.heldFromStage ? j.heldFromStage : j.stage);

/** Remembers which tab each project was last on, so picking the project in the rail returns to it. */
const KEY = (id: string) => `sf.tab.${id}`;
export const lastTab = (id: string): string | null => { try { return localStorage.getItem(KEY(id)); } catch { return null; } };
export const rememberTab = (id: string, path: string) => { try { localStorage.setItem(KEY(id), path); } catch { /* a convenience only */ } };
