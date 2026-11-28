import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { HubClient, HubError, type FetchLike, type TunnelRequest, type TunnelResponse } from "./client.js";
import { backoffMs } from "./reporter.js";
import { blockedRemoteBody, classifyRemote, REMOTE_BLOCKED, validateRemotePath } from "./remote-policy.js";
import type { HubSettings } from "./settings.js";

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 1024 * 1024;
const POLL_WAIT_SECONDS = 25;
const POLL_LIMIT = 10;
const LOOPS = 2;
const REQUEST_TIMEOUT_MS = 25_000;

export interface TunnelOptions {
  /** The factory's own API server. Requests are injected in-process: no socket, no network hop. */
  app: Pick<FastifyInstance, "inject">;
  port: number;
  logger: Logger;
  getSettings: () => HubSettings;
  getKey: () => string | undefined;
  /** Called for every MUTATING remote request that ran (route pattern + status only: never a body, header or query). */
  audit?: (entry: { method: string; route: string; status: number }) => void;
  fetch?: FetchLike; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; pollWaitSeconds?: number;
}

const json = (status: number, body: unknown): TunnelResponse => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") });
const fingerprint = (k: string) => createHash("sha256").update(k).digest("hex").slice(0, 16);

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
});

/**
 * Executes the hub dashboard's requests against this factory's own API. It runs ONLY while hub.enabled && hub.remoteAccess and a key
 * exists; sync() re-reads that every few seconds, so turning it off aborts the in-flight long polls at once. Request and response
 * bodies are never logged or stored.
 */
export class HubTunnel {
  private ctl: AbortController | undefined;
  private rejectedFp: string | undefined;
  private activeFp: string | undefined;
  constructor(private o: TunnelOptions) {}
  private now() { return (this.o.now ?? Date.now)(); }

  get running() { return this.ctl !== undefined; }

  /** Starts or stops the poll loops to match the current settings. Cheap; call it on a timer. Never throws. */
  sync(): void {
    let want = false, settings: HubSettings | undefined, key: string | undefined;
    try {
      settings = this.o.getSettings();
      // Off by default: with remote access off nothing here touches the keychain or the network.
      if (settings.enabled && settings.remoteAccess && settings.url) { key = this.o.getKey(); want = Boolean(key); }
    } catch { want = false; }
    if (want && key && this.rejectedFp && this.rejectedFp !== fingerprint(key)) this.rejectedFp = undefined; // new key: try again
    if (want && key && this.rejectedFp === fingerprint(key)) want = false; // the hub refused this key: stay stopped until it changes
    const fp = key ? fingerprint(key) : undefined;
    if (this.ctl && (!want || fp !== this.activeFp || settings?.url !== this.activeUrl)) this.halt();
    if (want && !this.ctl && settings && key) this.begin(settings.url, key, fp!);
  }

  private activeUrl: string | undefined;
  private begin(url: string, key: string, fp: string) {
    const ctl = new AbortController();
    this.ctl = ctl; this.activeFp = fp; this.activeUrl = url;
    const client = new HubClient({ url, key, fetch: this.o.fetch });
    this.o.logger.info("hub remote dashboard access is on");
    for (let i = 0; i < LOOPS; i++) void this.loop(client, ctl, fp);
  }

  halt(): void {
    if (!this.ctl) return;
    this.ctl.abort(); this.ctl = undefined; this.activeFp = undefined; this.activeUrl = undefined;
    this.o.logger.info("hub remote dashboard access is off");
  }
  stop(): void { this.halt(); }

  private async loop(client: HubClient, ctl: AbortController, fp: string): Promise<void> {
    const sleep = this.o.sleep ?? defaultSleep;
    let failures = 0;
    while (!ctl.signal.aborted) {
      try {
        const reqs = await client.tunnelNext(this.o.pollWaitSeconds ?? POLL_WAIT_SECONDS, POLL_LIMIT, ctl.signal);
        failures = 0;
        if (ctl.signal.aborted) return;
        if (reqs?.length) await Promise.allSettled(reqs.map((r) => this.handle(client, r, ctl, fp)));
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (e instanceof HubError && e.rejected) {
          this.rejectedFp = fp;
          this.o.logger.warn("hub rejected the API key; remote dashboard access stopped until the key changes");
          if (this.ctl === ctl) this.halt();
          return;
        }
        failures += 1;
        const wait = backoffMs(failures);
        this.o.logger.warn({ failures, retryInMs: wait }, `hub tunnel poll failed: ${(e as Error).message}`);
        await sleep(wait, ctl.signal);
      }
    }
  }

  private async handle(client: HubClient, req: TunnelRequest, ctl: AbortController, fp: string): Promise<void> {
    if (!req || typeof req.id !== "string") return;
    const expires = Date.parse(req.expiresAt);
    if (!Number.isFinite(expires) || expires <= this.now()) return; // the hub already gave up on it; running it now would be a surprise
    const res = await this.execute(req);
    try { await client.tunnelRespond(req.id, res); }
    catch (e) {
      if (e instanceof HubError && e.rejected) { this.rejectedFp = fp; if (this.ctl === ctl) this.halt(); }
      else this.o.logger.warn({ err: (e as Error).message }, "hub tunnel response failed");
    }
  }

  /** Runs one relayed request. Exposed for tests; every refusal is a normal response, never a throw. */
  async execute(req: TunnelRequest): Promise<TunnelResponse> {
    const started = this.now();
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "";
    const path = validateRemotePath(req.path);
    if (!path) return json(400, { error: "invalid request path" });
    const decision = classifyRemote(method, path.pathname);
    if (!decision.allowed) {
      this.o.logger.debug({ method, route: decision.route, reason: decision.reason }, "hub tunnel: refused");
      return json(403, { error: REMOTE_BLOCKED });
    }
    let payload: Buffer | undefined;
    if (req.bodyBase64) {
      if (typeof req.bodyBase64 !== "string" || req.bodyBase64.length > Math.ceil(MAX_REQUEST_BYTES * 4 / 3) + 4) return json(413, { error: "request too large" });
      payload = Buffer.from(req.bodyBase64, "base64");
    }
    const bodyReason = blockedRemoteBody(method, path.pathname, payload);
    if (bodyReason) {
      this.o.logger.debug({ method, route: decision.route, reason: bodyReason }, "hub tunnel: refused");
      return json(403, { error: REMOTE_BLOCKED });
    }
    // Only these two headers cross over. Everything that makes the request trusted locally is set here, not by the hub.
    const headers: Record<string, string> = {
      host: `127.0.0.1:${this.o.port}`, origin: `http://127.0.0.1:${this.o.port}`, "x-factory-ui": "1", "sec-fetch-site": "same-origin",
    };
    const ct = req.headers?.["content-type"], accept = req.headers?.accept;
    if (typeof ct === "string" && ct.length <= 200 && !/[\r\n]/.test(ct)) headers["content-type"] = ct;
    if (typeof accept === "string" && accept.length <= 200 && !/[\r\n]/.test(accept)) headers.accept = accept;

    let status: number, outType: string | undefined, body: Buffer;
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), REQUEST_TIMEOUT_MS); timer.unref(); });
      const r = await Promise.race([this.o.app.inject({ method: method as "GET", url: path.url, headers, remoteAddress: "127.0.0.1", ...(payload ? { payload } : {}) }), timeout]).finally(() => clearTimeout(timer));
      status = r.statusCode; body = r.rawPayload; outType = typeof r.headers["content-type"] === "string" ? r.headers["content-type"] : undefined;
    } catch (e) {
      status = (e as Error).message === "timeout" ? 504 : 502; body = Buffer.from(JSON.stringify({ error: status === 504 ? "the factory took too long to answer" : "the factory could not handle the request" })); outType = "application/json; charset=utf-8";
    }
    if (body.length > MAX_RESPONSE_BYTES) { status = 502; body = Buffer.from(JSON.stringify({ error: "response too large" })); outType = "application/json; charset=utf-8"; }
    this.o.logger.debug({ method, route: decision.route, status, ms: this.now() - started }, "hub tunnel: handled");
    if (decision.mutating) {
      this.o.logger.info({ method, route: decision.route, status }, "hub remote request changed something");
      try { this.o.audit?.({ method, route: decision.route, status }); } catch { /* auditing must never break the response */ }
    }
    return { status, headers: outType ? { "content-type": outType } : {}, bodyBase64: body.toString("base64") };
  }
}
