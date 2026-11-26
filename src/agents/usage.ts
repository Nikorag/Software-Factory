import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One rolling Claude plan window. `utilization` is 0..1; `resetsAt` is epoch milliseconds. */
export interface LimitWindow { utilization: number; resetsAt: number | null; status: string | null }
/** The latest plan-limit reading Claude Code reported (a `rate_limit_event` in its stream). A reading, not a forecast. */
export interface ClaudeLimits { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; status: string | null; capturedAt: number }

export const usageFile = (dataDir: string) => join(dataDir, "claude-usage.json");

const win = (w: unknown): LimitWindow | null => {
  const o = w as { utilization?: unknown; resetsAt?: unknown; status?: unknown } | undefined;
  if (!o || typeof o.utilization !== "number") return null;
  return { utilization: o.utilization, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt * 1000 : null, status: typeof o.status === "string" ? o.status : null };
};

/** Pure: the `rate_limit_info` object of a stream event -> limits (null when it carries nothing usable). */
export function parseRateLimitInfo(info: unknown, now = Date.now()): ClaudeLimits | null {
  const i = info as { status?: unknown; unifiedWindows?: { five_hour?: unknown; seven_day?: unknown }; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown } | undefined;
  if (!i || typeof i !== "object") return null;
  let fiveHour = win(i.unifiedWindows?.five_hour), sevenDay = win(i.unifiedWindows?.seven_day);
  // Older/other shapes name a single window by type.
  if (!fiveHour && !sevenDay) {
    const single = win({ utilization: i.utilization, resetsAt: i.resetsAt, status: i.status });
    if (single && i.rateLimitType === "five_hour") fiveHour = single; else if (single && i.rateLimitType === "seven_day") sevenDay = single;
  }
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, status: typeof i.status === "string" ? i.status : null, capturedAt: now };
}

export function writeLimits(file: string, l: ClaudeLimits): void {
  try { const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(l)); renameSync(tmp, file); } catch { /* a reading is a convenience, never a reason to fail a run */ }
}
export function readLimits(file: string): ClaudeLimits | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as ClaudeLimits; } catch { return null; }
}
/** A window whose reset time has passed no longer describes the plan: show it as unknown rather than as still full. */
export const windowIsCurrent = (w: LimitWindow | null, now = Date.now()): boolean => !!w && (w.resetsAt === null || w.resetsAt > now);
