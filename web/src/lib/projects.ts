import type { Job, Overview, Project } from "./types";
import { HELD, stageLabel } from "./format";

/** The redesign's status colours. Running = blue, needs you = amber, failed = red, queued = grey, done = green. */
export const TONE = { run: "#60A5FA", wait: "#FBBF24", fail: "#F87171", ok: "#4ADE80", queue: "#A1A1AA" } as const;

export type Bucket = "running" | "needs" | "queued" | "done";
const OPEN = new Set(["queued", "running", "waiting", "failed"]);

/** The PR is open and only a human merge is left: stored as queued/waiting (the engine re-polls it) but shown as Done. */
export const isAwaitingMerge = (j: Pick<Job, "stage" | "status">): boolean => j.stage === "MERGING" && ["queued", "waiting"].includes(j.status) && !HELD.includes(j.stage);
/** The status to summarise a job by: an awaiting-merge job counts as done. The job page keeps the detailed wording. */
export const effectiveStatus = (j: Pick<Job, "stage" | "status">): string => (isAwaitingMerge(j) ? "done" : j.status);

/** Jobs that deserve a tab: not finished, not archived. Finished work lives in the project's Overview tab. */
export function openJobs(o: Overview | null): Job[] {
  if (!o) return [];
  const seen = new Set<string>();
  return [...o.active, ...o.queued, ...o.recent].filter((j) => { if (seen.has(j.id) || !OPEN.has(j.status) || j.archivedAt) return false; seen.add(j.id); return true; });
}

export const bucketOf = (j: Job): Bucket => { const s = effectiveStatus(j); return s === "running" ? "running" : s === "queued" ? "queued" : s === "done" ? "done" : "needs"; };
export const toneOf = (j: Job): string => ({ running: TONE.run, waiting: TONE.wait, failed: TONE.fail, queued: TONE.queue, done: TONE.ok } as Record<string, string>)[effectiveStatus(j)] ?? TONE.queue;
export const statusLabel = (j: Job): string => ({ running: "Running", waiting: "Needs you", failed: "Failed", queued: "Queued", done: "Done", cancelled: "Cancelled" } as Record<string, string>)[effectiveStatus(j)] ?? j.status;

const SWATCHES = ["#A78BFA", "#2DD4BF", "#4ADE80", "#60A5FA", "#FB923C", "#F472B6", "#FBBF24", "#22D3EE"];
export const swatch = (id: string): string => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return SWATCHES[h % SWATCHES.length]!; };
export const initialOf = (p: Pick<Project, "name">): string => (p.name.trim()[0] ?? "?").toUpperCase();

/** The one-word state shown next to a project in the rail. */
export function projectMeta(jobs: Job[]): { text: string; color: string } {
  const n = (s: string) => jobs.filter((j) => effectiveStatus(j) === s).length;
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
