import { BUILTIN_HELP } from "./builtin-stages";

export const ago = (t: number | null | undefined) => {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
/** Compact duration: 1.2s, 3m 05s, 2h 14m. */
export const dur = (ms: number | null | undefined) => {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
export const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
/** Only https GitHub links are ever turned into anchors: a ticket or agent can put anything in a PR URL field. */
export const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/github\.com\//.test(u) ? u : null);
/** Links to the tracker (Linear, Jira cloud or a self-hosted Jira): http(s) only, so a ticket can never smuggle in javascript: or data:. */
export const safeLink = (u: unknown): string | null => {
  if (typeof u !== "string") return null;
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.href : null; } catch { return null; }
};
/** Friendly names for the stages that are not boxes on the flow chart (the job is held, finished or stopped there). */
const HELD_LABELS: Record<string, string> = { BLOCKED: "Blocked", FAILED: "Failed", CANCELLED: "Cancelled", PAUSED: "Paused", NEEDS_ATTENTION: "Needs attention", COMPLETED: "Completed" };
/** Stage names by id, as a workflow defines them (see stageNames()). Anything it does not name falls back to the built-in stage's friendly name. */
export type StageNames = Record<string, string> | undefined;
/**
 * What a person sees for a stage id such as LOCAL_MODEL_REVIEW: the stage's name in the job's workflow ("Independent review"), or for a
 * built-in stage with no workflow at hand the same friendly name. The engine's ids stay in the API, the database and the logs.
 */
export const stageLabel = (s: string, names?: StageNames) => names?.[s] ?? BUILTIN_HELP[s]?.name ?? HELD_LABELS[s] ?? s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const BUILTIN_IDS = [...Object.keys(BUILTIN_HELP), ...Object.keys(HELD_LABELS)];
const rx = new WeakMap<object, RegExp>();
const BASE = new RegExp(`\\b(${BUILTIN_IDS.join("|")})\\b`, "g");
const pattern = (names: NonNullable<StageNames>) => {
  let r = rx.get(names);
  if (!r) { r = new RegExp(`\\b(${[...new Set([...BUILTIN_IDS, ...Object.keys(names)])].join("|")})\\b`, "g"); rx.set(names, r); }
  return r;
};
/** Rewrites any stage ids inside a message ("LOCAL_MODEL_REVIEW -> REMEDIATION") into their friendly names. */
export const stageText = <T extends string | null | undefined>(t: T, names?: StageNames): T => (typeof t === "string" ? (t.replace(names ? pattern(names) : BASE, (m) => stageLabel(m, names)) as T) : t);
export const HELD = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"];
