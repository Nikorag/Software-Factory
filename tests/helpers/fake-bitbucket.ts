import { createServer, type IncomingMessage, type Server } from "node:http";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A Bitbucket Cloud 2.0 stand-in for tests: the pull request, statuses, comments, branch-restrictions and pipelines endpoints the factory uses. */
export class FakeBitbucket {
  server!: Server; url = "";
  /** the Authorization header the server accepts */
  expect = "Bearer good-token";
  repos = new Map<string, Json>([["acme/widgets", { full_name: "acme/widgets", is_private: true, mainbranch: { name: "main" } }]]);
  prs: Json[] = [];
  statuses = new Map<number, Json[]>();
  comments: { pr: number; raw: string }[] = [];
  restrictions: Json[] = [];
  pipelines: Json[] = [];
  calls: { method: string; path: string; body?: Json; auth?: string }[] = [];
  restrictionStatus = 200;

  addPr(o: { id?: number; branch: string; base?: string; state?: string; title?: string; participants?: Json[]; hash?: string }) {
    const id = o.id ?? this.prs.length + 1;
    const pr = { id, title: o.title ?? `PR ${id}`, state: o.state ?? "OPEN", draft: false, source: { branch: { name: o.branch }, commit: { hash: o.hash ?? "abc123" } }, destination: { branch: { name: o.base ?? "main" } },
      links: { html: { href: `https://bitbucket.org/acme/widgets/pull-requests/${id}` } }, updated_on: "2026-11-25T10:00:00Z", participants: o.participants ?? [] };
    this.prs.push(pr);
    return pr;
  }
  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/2.0`;
    return this;
  }
  stop() { this.server.close(); }

  private async body(req: IncomingMessage): Promise<Json> { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); try { return JSON.parse(Buffer.concat(c).toString() || "{}"); } catch { return {}; } }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const u = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown, text = false) => { res.writeHead(status, { "content-type": text ? "text/plain" : "application/json" }); res.end(text ? String(body) : JSON.stringify(body)); };
    const body = req.method === "GET" ? {} : await this.body(req);
    this.calls.push({ method: req.method!, path: u.pathname + u.search, body: Object.keys(body).length ? body : undefined, auth: req.headers.authorization });
    if (req.headers.authorization !== this.expect) return send(401, { error: { message: "Token is invalid, expired, or not supported for this endpoint." } });
    const m = /^\/2\.0\/repositories\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return send(404, { error: { message: "not found" } });
    const repo = m[1]!, rest = m[2] ?? "";
    if (!this.repos.has(repo)) return send(404, { error: { message: `Repository ${repo} not found` } });
    if (rest === "") return send(200, this.repos.get(repo));
    if (rest === "/pullrequests" && req.method === "GET") {
      const q = /source\.branch\.name="([^"]+)"/.exec(u.searchParams.get("q") ?? "")?.[1];
      const states = u.searchParams.getAll("state");
      return send(200, { values: this.prs.filter((p) => (!q || p.source.branch.name === q) && (!states.length || states.includes(p.state))) });
    }
    if (rest === "/pullrequests" && req.method === "POST") {
      if (this.prs.some((p) => p.state === "OPEN" && p.source.branch.name === body.source.branch.name)) return send(400, { error: { message: "There is already an open pull request for this branch" } });
      return send(201, this.addPr({ branch: body.source.branch.name, base: body.destination.branch.name, title: body.title }));
    }
    let r: RegExpExecArray | null;
    if ((r = /^\/pullrequests\/(\d+)$/.exec(rest))) { const pr = this.prs.find((p) => p.id === Number(r![1])); return pr ? send(200, pr) : send(404, { error: { message: "no pr" } }); }
    if ((r = /^\/pullrequests\/(\d+)\/statuses$/.exec(rest))) return send(200, { values: this.statuses.get(Number(r[1])) ?? [] });
    if ((r = /^\/pullrequests\/(\d+)\/comments$/.exec(rest))) { this.comments.push({ pr: Number(r[1]), raw: body.content?.raw }); return send(201, {}); }
    if (rest.startsWith("/branch-restrictions")) return this.restrictionStatus === 200 ? send(200, { values: this.restrictions }) : send(this.restrictionStatus, { error: { message: "forbidden" } });
    if (rest.startsWith("/pipelines") && !/\/steps/.test(rest)) return send(200, { values: this.pipelines });
    if ((r = /^\/pipelines\/([^/]+)\/steps$/.exec(rest))) return send(200, { values: [{ uuid: "{step-1}", state: { result: { name: "FAILED" } } }] });
    if ((r = /^\/pipelines\/([^/]+)\/steps\/([^/]+)\/log$/.exec(rest))) return send(200, "npm ERR! test failed\nexit 1", true);
    return send(404, { error: { message: `unhandled ${req.method} ${rest}` } });
  }
}
