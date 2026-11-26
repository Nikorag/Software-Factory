export class HubError extends Error {
  constructor(message: string, public readonly status: number | null) { super(message); this.name = "HubError"; }
  /** The hub refused the key: stop retrying until the user connects with a new one. */
  get rejected() { return this.status === 401 || this.status === 403; }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** One dashboard request relayed by the hub. Everything in it is untrusted input. */
export interface TunnelRequest { id: string; method: string; path: string; headers?: { "content-type"?: string; accept?: string }; bodyBase64?: string; expiresAt: string }
export interface TunnelResponse { status: number; headers: { "content-type"?: string }; bodyBase64: string }

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

  /** GET /v1/factory/tunnel/next: the remote dashboard's pending requests (long poll). null = none (204). */
  async tunnelNext(wait: number, limit: number, signal?: AbortSignal): Promise<TunnelRequest[] | null> {
    const res = await this.call("GET", `/v1/factory/tunnel/next?wait=${wait}&limit=${limit}`, undefined, (wait + 10) * 1000, signal);
    if (res.status === 204) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(await res.text()); } catch { throw new HubError("hub sent an unreadable tunnel response", res.status); }
    const reqs = (parsed as { requests?: unknown })?.requests;
    return Array.isArray(reqs) ? (reqs as TunnelRequest[]) : null;
  }

  /** POST /v1/factory/tunnel/:id/response. Returns false if the hub no longer wants it (404: the request expired). */
  async tunnelRespond(id: string, body: TunnelResponse): Promise<boolean> {
    const res = await this.call("POST", `/v1/factory/tunnel/${encodeURIComponent(id)}/response`, JSON.stringify(body), undefined, undefined, [404]);
    return res.status !== 404;
  }

  private async call(method: "GET" | "POST", path: string, body: string | undefined, timeoutMs = this.o.timeoutMs ?? 15_000, signal?: AbortSignal, okStatuses: number[] = []) {
    const f = this.o.fetch ?? (fetch as unknown as FetchLike);
    let res;
    try {
      res = await f(`${this.o.url}${path}`, {
        method, headers: { ...(body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${this.o.key}` }, body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (signal?.aborted) throw new HubError("aborted", null);
      const m = (e as Error).name === "TimeoutError" ? "timed out" : ((e as { cause?: { code?: string } }).cause?.code ?? "network error");
      throw new HubError(`hub unreachable (${m})`, null);
    }
    if (!res.ok && !okStatuses.includes(res.status)) throw new HubError(`hub returned ${res.status}`, res.status);
    return res;
  }

  heartbeat(version: string | undefined, metadata: Record<string, unknown>) { return this.post("/v1/factory/heartbeat", { version, metadata }); }
  sync(body: SyncIn) { return this.post("/v1/factory/sync", body); }
  events(events: EventIn[]) { return this.post("/v1/factory/events", { events }); }
}
