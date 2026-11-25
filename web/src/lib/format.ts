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
export const stageLabel = (s: string) => s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const HELD = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"];
