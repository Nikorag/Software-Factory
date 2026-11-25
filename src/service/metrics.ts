import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { freemem, loadavg, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { count, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, jobs, linearOutbox } from "../db/schema.js";

const run = promisify(execFile);
export type Runner = (file: string, args: string[]) => Promise<string>;
const defaultRunner: Runner = async (f, a) => (await run(f, a, { timeout: 8000 })).stdout;

export interface SystemInfo {
  memory: { totalBytes: number; freeBytes: number; availableBytes: number; freePercent: number | null; pressure: "normal" | "warn" | "critical" | "unknown" };
  load: number[]; uptimeSeconds: number; disk: { freeBytes: number; totalBytes: number } | null; platform: string;
}

/** macOS reports "System-wide memory free percentage: NN%" (memory_pressure). os.freemem() alone understates available memory there. */
export async function systemInfo(dataDir: string, r: Runner = defaultRunner): Promise<SystemInfo> {
  const total = totalmem(), free = freemem();
  let freePercent: number | null = null;
  try { freePercent = Number(/free percentage:\s*(\d+)%/.exec(await r("/usr/bin/memory_pressure", []))?.[1] ?? NaN); } catch { /* not macOS */ }
  if (!Number.isFinite(freePercent)) freePercent = null;
  const available = freePercent === null ? free : Math.round((total * freePercent) / 100);
  let disk: SystemInfo["disk"] = null;
  try { const st = statfsSync(dataDir); disk = { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize }; } catch { /* dataDir not created yet */ }
  const pct = freePercent ?? (available / total) * 100;
  return { memory: { totalBytes: total, freeBytes: free, availableBytes: available, freePercent, pressure: pct < 8 ? "critical" : pct < 20 ? "warn" : freePercent === null && !Number.isFinite(pct) ? "unknown" : "normal" }, load: loadavg(), uptimeSeconds: Math.round(uptime()), disk, platform: process.platform };
}

export interface Counts { byStatus: Record<string, number>; outbox: { pending: number; failed: number }; recentAgentFailures: { rateLimited: number; auth: number; timeout: number; total: number } }

export function counts(db: FactoryDb, now = new Date(), windowMs = 3600_000): Counts {
  const byStatus: Record<string, number> = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of db.select({ s: jobs.status, n: count() }).from(jobs).groupBy(jobs.status).all()) byStatus[r.s] = r.n;
  const ob = (st: "pending" | "failed") => db.select({ n: count() }).from(linearOutbox).where(eq(linearOutbox.status, st)).get()?.n ?? 0;
  const since = now.getTime() - windowMs;
  const recent = db.select().from(agentInvocations).all().filter((a) => a.startedAt.getTime() >= since && a.usageJson);
  const fail = (f: string) => recent.filter((a) => (JSON.parse(a.usageJson!) as { failure?: string }).failure === f).length;
  return { byStatus, outbox: { pending: ob("pending"), failed: ob("failed") }, recentAgentFailures: { rateLimited: fail("rate_limited"), auth: fail("auth"), timeout: fail("timeout"), total: recent.filter((a) => (JSON.parse(a.usageJson!) as { failure?: string }).failure).length } };
}

export interface HealthItem { name: string; status: "ok" | "warn" | "fail"; detail: string; checkedAt: number }

export interface HealthDeps {
  trackerName?: string; // "linear" (default) or "jira": what the tracker probe is called
  claudeAuth?: () => Promise<string>; // output of `claude auth status`
  linearViewer?: () => Promise<{ name: string }>;
  ghAuth?: () => Promise<string>;
  specifyInstalled?: () => boolean;
  sandboxAvailable?: () => boolean;
  localModels?: () => Promise<string[]>; // only when a route uses a local model
  now?: () => number;
  ttlMs?: number;
}

/** Cached health of everything the factory depends on. Each probe is read-only and cheap (no model tokens are used). */
export class HealthChecker {
  private cache = new Map<string, HealthItem>();
  constructor(private readonly d: HealthDeps) {}
  private now = () => (this.d.now ?? Date.now)();

  private async probe(name: string, fn: () => Promise<Pick<HealthItem, "status" | "detail">>): Promise<HealthItem> {
    const hit = this.cache.get(name);
    if (hit && this.now() - hit.checkedAt < (this.d.ttlMs ?? 300_000)) return hit;
    let r: Pick<HealthItem, "status" | "detail">;
    try { r = await fn(); } catch (e) { r = { status: "fail", detail: (e as Error).message.slice(0, 200) }; }
    const item = { name, ...r, checkedAt: this.now() };
    this.cache.set(name, item);
    return item;
  }

  async check(): Promise<HealthItem[]> {
    const d = this.d;
    const out: Promise<HealthItem>[] = [];
    if (d.claudeAuth) out.push(this.probe("claude code", async () => {
      const j = JSON.parse(await d.claudeAuth!()) as { loggedIn?: boolean; authMethod?: string };
      return j.loggedIn ? { status: "ok", detail: `logged in (${j.authMethod ?? "unknown"} subscription login)` } : { status: "fail", detail: "not logged in: run `claude` and /login" };
    }));
    if (d.linearViewer) out.push(this.probe(d.trackerName ?? "linear", async () => ({ status: "ok", detail: `authenticated as ${(await d.linearViewer!()).name}` })));
    if (d.ghAuth) out.push(this.probe("github", async () => (/Logged in/.test(await d.ghAuth!()) ? { status: "ok", detail: "gh is authenticated" } : { status: "fail", detail: "gh is not logged in" })));
    if (d.sandboxAvailable) out.push(this.probe("sandbox", async () => (d.sandboxAvailable!() ? { status: "ok", detail: "sandbox-exec available: project code runs confined" } : { status: "fail", detail: "sandbox-exec missing: project commands will be refused" })));
    if (d.specifyInstalled) out.push(this.probe("spec kit", async () => (d.specifyInstalled!() ? { status: "ok", detail: "specify installed" } : { status: "warn", detail: "specify not found (needed to onboard projects)" })));
    if (d.localModels) out.push(this.probe("local model", async () => { const m = await d.localModels!(); return m.length ? { status: "ok", detail: `${m.length} model(s) loaded` } : { status: "warn", detail: "server up, no model loaded" }; }));
    return Promise.all(out);
  }
}
