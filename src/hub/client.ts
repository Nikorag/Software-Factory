export class HubError extends Error {
  constructor(message: string, public readonly status: number | null) { super(message); this.name = "HubError"; }
  /** The hub refused the key: stop retrying until the user connects with a new one. */
  get rejected() { return this.status === 401 || this.status === 403; }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface EventIn { id: string; type: string; jobId?: string; occurredAt: string; payload: Record<string, unknown> }
export interface SyncIn {
  projects: Array<{ id: string; name: string; metadata?: Record<string, unknown> }>;
  jobs: Array<{ id: string; projectId?: string; title?: string; stage?: string; status?: string; workflowId?: string; metadata?: Record<string, unknown> }>;
  workflows: Array<{ id: string; name: string; version?: string; definition?: Record<string, unknown> }>;
}

/** Thin, timeout-bounded client for the hub's factory API. The key goes only in the Authorization header and never into an error message. */
export class HubClient {
  constructor(private o: { url: string; key: string; fetch?: FetchLike; timeoutMs?: number }) {}

  private async post(path: string, body: unknown): Promise<void> {
    const f = this.o.fetch ?? (fetch as unknown as FetchLike);
    let res;
    try {
      res = await f(`${this.o.url}${path}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.o.key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      const m = (e as Error).name === "TimeoutError" ? "timed out" : ((e as { cause?: { code?: string } }).cause?.code ?? "network error");
      throw new HubError(`hub unreachable (${m})`, null);
    }
    if (!res.ok) throw new HubError(`hub returned ${res.status}`, res.status);
    await res.text().catch(() => "");
  }

  heartbeat(version: string | undefined, metadata: Record<string, unknown>) { return this.post("/v1/factory/heartbeat", { version, metadata }); }
  sync(body: SyncIn) { return this.post("/v1/factory/sync", body); }
  events(events: EventIn[]) { return this.post("/v1/factory/events", { events }); }
}
