import { createServer, type IncomingMessage, type Server } from "node:http";
import type { SecretStore } from "../../src/jira/auth.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const adf = (t: string) => ({ version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });

export const memoryStore = (init: Record<string, string> = {}): SecretStore & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, get: (a) => data[a] || undefined, set: (a, v) => { data[a] = v; } };
};

/**
 * A small Atlassian + Jira Cloud stand-in for tests, shaped after the documented endpoints: the OAuth token endpoint with ROTATING refresh
 * tokens, accessible-resources, and the Jira REST v3 calls the factory makes. It records what it was asked so tests can assert on it.
 */
export class FakeAtlassian {
  server!: Server; url = "";
  clientId = "client1234567890abcd"; clientSecret = "secret-secret-secret-1234";
  code = "good-code"; accessToken = "access-0"; refreshToken = "refresh-0"; tokenGen = 0; usedRefresh = new Set<string>();
  sites = [{ id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:jira-work"] }];
  statuses = [["10", "To Do", "new"], ["11", "Ready for specification", "new"], ["12", "Specification review", "indeterminate"], ["13", "In Progress", "indeterminate"], ["14", "Ready for review", "indeterminate"], ["15", "Done", "done"], ["16", "Blocked", "indeterminate"]] as const;
  projects = [{ id: "10000", key: "ENG", name: "Engineering" }, { id: "10001", key: "OPS", name: "Operations" }];
  components = [{ id: "20000", name: "Web" }, { id: "20001", name: "API" }];
  labelNames = ["urgent", "factory-ready"];
  /** from status id -> allowed target status ids ("*" = anything) */
  transitions: Record<string, string[] | "*"> = {};
  issues = new Map<string, Json>();
  comments = new Map<string, Json[]>();
  calls: { method: string; path: string; body?: Json; query?: Record<string, string> }[] = [];
  jqls: string[] = [];
  failNext: { status: number; headers?: Record<string, string> } | null = null;
  tokenRequests: Json[] = [];
  expireAccessOnNextCall = false;

  addIssue(o: { key: string; status?: string; labels?: string[]; components?: string[]; summary?: string; project?: string; description?: string }) {
    const [pid] = [this.projects.find((p) => p.key === (o.project ?? o.key.split("-")[0]))!];
    const st = this.statuses.find((s) => s[1] === (o.status ?? "Ready for specification"))!;
    this.issues.set(o.key, { id: String(30000 + this.issues.size), key: o.key, fields: {
      summary: o.summary ?? `Issue ${o.key}`, description: adf(o.description ?? "do the thing"), status: { id: st[0], name: st[1], statusCategory: { key: st[2] } },
      project: pid, labels: o.labels ?? [], components: (o.components ?? []).map((n) => this.components.find((c) => c.name === n)!) } });
    this.comments.set(o.key, []);
    return this.issues.get(o.key)!;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  stop() { this.server.close(); }
  get authBase() { return this.url; }               // POST {authBase}/oauth/token
  get apiBase() { return `${this.url}/api`; }       // {apiBase}/ex/jira/{cloud}/rest/api/3/...  and /api/oauth/token/accessible-resources

  private async body(req: IncomingMessage): Promise<Json> { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); try { return JSON.parse(Buffer.concat(c).toString() || "{}"); } catch { return {}; } }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const u = new URL(req.url!, this.url);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(status === 204 ? "" : JSON.stringify(body)); };
    const body = req.method === "GET" ? {} : await this.body(req);
    const query = Object.fromEntries(u.searchParams);

    if (u.pathname === "/oauth/token") {
      this.tokenRequests.push(body);
      if (body.client_id !== this.clientId || body.client_secret !== this.clientSecret) return send(403, { error: "access_denied" });
      if (body.grant_type === "authorization_code") {
        if (body.code !== this.code) return send(403, { error: "invalid_grant" });
        this.code = "used"; this.accessToken = `access-${++this.tokenGen}`; this.refreshToken = `refresh-${this.tokenGen}`;
        return send(200, { access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 3600, scope: "read:jira-work write:jira-work read:jira-user offline_access" });
      }
      if (body.grant_type === "refresh_token") {
        if (body.refresh_token !== this.refreshToken) return send(403, { error: "invalid_grant", error_description: this.usedRefresh.has(body.refresh_token) ? "refresh token already used" : "unknown refresh token" });
        this.usedRefresh.add(this.refreshToken);
        this.accessToken = `access-${++this.tokenGen}`; this.refreshToken = `refresh-${this.tokenGen}`;
        return send(200, { access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 3600, scope: "read:jira-work" });
      }
      return send(400, { error: "unsupported_grant_type" });
    }

    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (this.expireAccessOnNextCall) { this.expireAccessOnNextCall = false; return send(401, { message: "token expired" }); }
    if (bearer !== this.accessToken) return send(401, { message: "Unauthorized" });
    if (u.pathname === "/api/oauth/token/accessible-resources") return send(200, this.sites);

    const m = /^\/api\/ex\/jira\/([^/]+)(\/rest\/api\/3\/.*)$/.exec(u.pathname);
    if (!m) return send(404, { errorMessages: ["not found"] });
    const path = m[2]!;
    this.calls.push({ method: req.method!, path, body: Object.keys(body).length ? body : undefined, query });
    if (this.failNext) { const f = this.failNext; this.failNext = null; return send(f.status, { errorMessages: ["injected"] }, f.headers); }

    if (path === "/rest/api/3/myself") return send(200, { accountId: "acct-1", displayName: "Jamie" });
    if (path === "/rest/api/3/project/search") return send(200, { values: this.projects, isLast: true });
    let r: RegExpExecArray | null;
    if ((r = /^\/rest\/api\/3\/project\/([^/]+)\/components$/.exec(path))) return send(200, this.components);
    if ((r = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(path))) return send(200, [{ name: "Task", statuses: this.statuses.map(([id, name, cat]) => ({ id, name, statusCategory: { key: cat } })) }, { name: "Bug", statuses: this.statuses.slice(0, 3).map(([id, name, cat]) => ({ id, name, statusCategory: { key: cat } })) }]);
    if (path === "/rest/api/3/label") return send(200, { values: this.labelNames, isLast: true });
    if (path === "/rest/api/3/search/jql") {
      this.jqls.push(query.jql ?? "");
      const jql = query.jql ?? "";
      const key = /key = "([^"]+)"/.exec(jql)?.[1], status = /status = "([^"]+)"/.exec(jql)?.[1], label = /labels = "([^"]+)"/.exec(jql)?.[1];
      const comp = /component = "([^"]+)"/.exec(jql)?.[1], title = /summary ~ "([^"]+)"/.exec(jql)?.[1], proj = /project = "([^"]+)"/.exec(jql)?.[1];
      const open = /statusCategory != Done/.test(jql);
      const list = [...this.issues.values()].filter((i) => (!proj || i.key.startsWith(`${proj}-`)) && (!key || i.key === key) && (!status || i.fields.status.name === status) && (!label || i.fields.labels.includes(label))
        && (!comp || i.fields.components.some((c: Json) => c.name === comp)) && (!title || i.fields.summary.toLowerCase().includes(title.toLowerCase())) && (!open || i.fields.status.statusCategory.key !== "done"));
      return send(200, { issues: list, isLast: true });
    }
    const find = (idOrKey: string) => this.issues.get(idOrKey) ?? [...this.issues.values()].find((i) => i.id === idOrKey); // Jira accepts either
    if ((r = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path))) {
      const issue = find(r[1]!);
      if (!issue) return send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      if (req.method === "PUT") {
        for (const op of body.update?.labels ?? []) { if (op.add && !issue.fields.labels.includes(op.add)) issue.fields.labels.push(op.add); if (op.remove) issue.fields.labels = issue.fields.labels.filter((l: string) => l !== op.remove); }
        return send(204, {});
      }
      return send(200, issue);
    }
    if ((r = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(path))) {
      const issue = find(r[1]!);
      if (!issue) return send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      const allowed = this.transitions[issue.fields.status.id] ?? "*";
      const to = this.statuses.filter(([id]) => (allowed === "*" ? id !== issue.fields.status.id : allowed.includes(id)));
      if (req.method === "GET") return send(200, { transitions: to.map(([id, name, cat]) => ({ id: `t${id}`, name: `Move to ${name}`, to: { id, name, statusCategory: { key: cat } } })) });
      const target = to.find(([id]) => `t${id}` === body.transition?.id);
      if (!target) return send(400, { errorMessages: ["transition not valid"] });
      issue.fields.status = { id: target[0], name: target[1], statusCategory: { key: target[2] } };
      return send(204, {});
    }
    if ((r = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path))) {
      const key = find(r[1]!)?.key;
      const list = key ? this.comments.get(key) : undefined;
      if (!list) return send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      if (req.method === "POST") { list.push({ id: String(900 + list.length), body: body.body, created: new Date().toISOString(), author: { displayName: "Software Factory" } }); return send(201, list.at(-1)); }
      return send(200, { comments: list, total: list.length });
    }
    if ((r = /^\/rest\/api\/3\/issue\/([^/]+)\/remotelink$/.exec(path))) return send(201, { id: 1 });
    return send(404, { errorMessages: [`unhandled ${req.method} ${path}`] });
  }
}
