import type { Logger } from "pino";
import * as control from "../core/control.js";
import type { Engine } from "../core/engine.js";
import type { FactoryDb } from "../db/client.js";
import type { DiscoveryReport } from "../linear/discovery.js";
import type { FlushResult } from "../linear/outbox.js";

export interface SchedulerDeps {
  db: FactoryDb;
  engine: Engine;
  logger: Logger;
  discover: () => Promise<DiscoveryReport>;
  flush: () => Promise<FlushResult>;
  validate: () => Promise<void>;
  intervals?: Partial<{ discoveryMs: number; workerIdleMs: number; pausedPollMs: number; validateMs: number; maxBackoffMs: number }>;
  now?: () => number;
}

export interface SchedulerStatus {
  running: boolean; startedAt: number | null;
  lastDiscovery: { at: number; ok: boolean; enqueued: number; skipped: number; error?: string } | null;
  lastFlush: { at: number; ok: boolean; sent: number; failed: number; pending: number; error?: string } | null;
  lastValidation: { at: number; ok: boolean; error?: string } | null;
  consecutiveDiscoveryErrors: number;
}

/**
 * The service loop. Three independent loops so a long-running job never starves polling or write-back:
 *  - worker: keeps free slots filled with claimable jobs (the engine enforces the global and per-project concurrency limits);
 *  - discovery: polls Linear for eligible issues, then flushes the Linear outbox;
 *  - validation: re-checks enrolled projects periodically.
 * Pause and emergency stop are honoured by every loop. A failing dependency backs off; it never kills the service.
 */
export class Scheduler {
  private stopping = false;
  private readonly ac = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly s: SchedulerStatus = { running: false, startedAt: null, lastDiscovery: null, lastFlush: null, lastValidation: null, consecutiveDiscoveryErrors: 0 };
  private readonly iv;
  private readonly now: () => number;

  constructor(private readonly d: SchedulerDeps) {
    this.iv = { discoveryMs: 60_000, workerIdleMs: 2_000, pausedPollMs: 1_000, validateMs: 6 * 3600_000, maxBackoffMs: 10 * 60_000, ...d.intervals };
    this.now = d.now ?? Date.now;
  }

  status(): SchedulerStatus { return { ...this.s }; }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.ac.signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      this.ac.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  private halted = () => { const c = control.getControl(this.d.db); return c.paused || c.emergencyStop; };

  start(): void {
    if (this.s.running) return;
    this.s.running = true; this.s.startedAt = this.now();
    this.loops = [this.worker(), this.discovery(), this.validation()];
  }

  /** Graceful stop: end the loops, then tell any running agent to stand down (its job is re-queued untouched for the next start). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.ac.abort();
    const n = this.d.engine.abortActive("shutdown");
    if (n) this.d.logger.warn({ jobs: n }, "shutdown: running stages aborted, jobs re-queued");
    await Promise.allSettled(this.loops);
    await this.d.engine.idle(); // jobs run in the background now: wait for the aborted ones to settle
    this.s.running = false;
  }

  private async worker(): Promise<void> {
    while (!this.stopping) {
      if (this.halted()) { await this.sleep(this.iv.pausedPollMs); continue; }
      // Jobs run in the background (up to the configured concurrency); this loop just keeps free slots filled.
      let started = 0;
      try { started = this.d.engine.start(); }
      catch (e) { this.d.logger.error({ err: String(e) }, "worker pass failed"); await this.sleep(5_000); }
      await this.sleep(started > 0 ? Math.min(250, this.iv.workerIdleMs) : this.iv.workerIdleMs);
    }
  }

  private async discovery(): Promise<void> {
    while (!this.stopping) {
      if (!this.halted()) {
        try {
          const r = await this.d.discover();
          const err = r.errors.length ? r.errors.map((e) => `${e.projectId}: ${e.error}`).join("; ") : undefined;
          this.s.lastDiscovery = { at: this.now(), ok: !err, enqueued: r.enqueued.length, skipped: r.skipped.length, error: err };
          this.s.consecutiveDiscoveryErrors = err ? this.s.consecutiveDiscoveryErrors + 1 : 0;
          if (r.enqueued.length) this.d.logger.info({ enqueued: r.enqueued.map((e) => e.key) }, "discovered issues");
        } catch (e) {
          this.s.lastDiscovery = { at: this.now(), ok: false, enqueued: 0, skipped: 0, error: String(e) };
          this.s.consecutiveDiscoveryErrors++;
          this.d.logger.error({ err: String(e) }, "discovery failed");
        }
      }
      try { // write-back continues while paused: it only reflects state that already exists
        const f = await this.d.flush();
        this.s.lastFlush = { at: this.now(), ok: f.failed === 0, ...f };
      } catch (e) {
        this.s.lastFlush = { at: this.now(), ok: false, sent: 0, failed: 0, pending: 0, error: String(e) };
        this.d.logger.error({ err: String(e) }, "linear flush failed");
      }
      const backoff = Math.min(this.iv.discoveryMs * 2 ** Math.min(this.s.consecutiveDiscoveryErrors, 5), this.iv.maxBackoffMs);
      await this.sleep(Math.max(backoff, this.iv.discoveryMs));
    }
  }

  private async validation(): Promise<void> {
    while (!this.stopping) {
      try { await this.d.validate(); this.s.lastValidation = { at: this.now(), ok: true }; }
      catch (e) { this.s.lastValidation = { at: this.now(), ok: false, error: String(e) }; this.d.logger.error({ err: String(e) }, "project validation failed"); }
      await this.sleep(this.iv.validateMs);
    }
  }
}
