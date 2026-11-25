import { planUpdate, type Run, type UpdatePlan } from "./update.js";

export interface UpdateStatus { current: string | null; latest: string | null; available: boolean; checkedAt: number | null; error?: string }

/**
 * "Is there a newer release?" for the dashboard notice. Asks git (a tag fetch) at most once per `ttlMs`, never blocks a request on a slow
 * network for long, and fails quietly: no notice is better than an error banner on a machine that is offline.
 */
export class UpdateChecker {
  private cache: UpdateStatus | null = null;
  private inflight: Promise<UpdateStatus> | null = null;
  constructor(private o: { ttlMs?: number; root?: string; run?: Run; now?: () => number; plan?: (opts: { root?: string; run?: Run }) => Promise<UpdatePlan> } = {}) {}

  async status(): Promise<UpdateStatus> {
    const now = (this.o.now ?? Date.now)(), ttl = this.o.ttlMs ?? 6 * 3600_000;
    if (this.cache && now - (this.cache.checkedAt ?? 0) < ttl) return this.cache;
    this.inflight ??= (async () => {
      try {
        const p = await (this.o.plan ?? planUpdate)({ root: this.o.root, run: this.o.run });
        this.cache = { current: p.current, latest: p.latestTag ?? p.target, available: !p.upToDate, checkedAt: now };
      } catch (e) {
        this.cache = { current: null, latest: null, available: false, checkedAt: now, error: (e as Error).message.split("\n")[0] ?? "check failed" }; // retried after the ttl
      }
      return this.cache;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
