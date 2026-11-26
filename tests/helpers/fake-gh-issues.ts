import type { GhExec } from "../../src/github/client.js";

/** An in-memory GitHub REST API behind `gh api`, just enough for the Issues tracker: issues, labels, milestones, comments, search. */
export interface FakeIssue { number: number; title: string; body: string | null; state: "open" | "closed"; labels: string[]; milestone: number | null; pull_request?: object; updated: number }
export class FakeGhIssues {
  repos = new Map<string, { issues: Map<number, FakeIssue>; labels: Map<string, { name: string; color: string }>; milestones: Map<number, string>; comments: Map<number, { id: number; body: string; user: string; created_at: string }[]> }>();
  calls: string[] = [];
  failNext: { match: RegExp; message: string } | null = null;
  login = "factory-bot";
  private seq = 1; private tick = 1;

  repo(name: string) {
    let r = this.repos.get(name);
    if (!r) { r = { issues: new Map(), labels: new Map(), milestones: new Map(), comments: new Map() }; this.repos.set(name, r); }
    return r;
  }
  addIssue(repo: string, o: Partial<FakeIssue> & { title?: string } = {}): FakeIssue {
    const r = this.repo(repo);
    const number = o.number ?? this.seq++;
    const issue: FakeIssue = { number, title: o.title ?? `Issue ${number}`, body: o.body ?? null, state: o.state ?? "open", labels: o.labels ?? [], milestone: o.milestone ?? null, updated: this.tick++, ...(o.pull_request ? { pull_request: o.pull_request } : {}) };
    r.issues.set(number, issue);
    for (const l of issue.labels) if (!r.labels.has(l.toLowerCase())) r.labels.set(l.toLowerCase(), { name: l, color: "ededed" });
    return issue;
  }
  addMilestone(repo: string, n: number, title: string) { this.repo(repo).milestones.set(n, title); }

  private view(repo: string, i: FakeIssue) {
    const r = this.repo(repo);
    return { number: i.number, title: i.title, body: i.body, state: i.state, html_url: `https://github.com/${repo}/issues/${i.number}`, labels: i.labels.map((name) => ({ name })),
      milestone: i.milestone ? { number: i.milestone, title: r.milestones.get(i.milestone) } : null, ...(i.pull_request ? { pull_request: i.pull_request } : {}) };
  }
  private page<T>(rows: T[], qs: URLSearchParams): T[] { const per = Number(qs.get("per_page") ?? 30), p = Number(qs.get("page") ?? 1); return rows.slice((p - 1) * per, p * per); }
  private err(status: number, text: string): never { throw Object.assign(new Error(`gh: ${text} (HTTP ${status})`), { stderr: `gh: ${text} (HTTP ${status})` }); }

  run: GhExec = async (args, o) => {
    const i = args.indexOf("api");
    const method = args[args.indexOf("-X") + 1]!;
    const target = args.find((a, k) => k > i && a.startsWith("/"))!;
    const body = o.input ? JSON.parse(o.input) : undefined;
    this.calls.push(`${method} ${target}`);
    if (this.failNext && this.failNext.match.test(`${method} ${target}`)) { const f = this.failNext; this.failNext = null; throw Object.assign(new Error(f.message), { stderr: f.message }); }
    const u = new URL(target, "https://api.github.com");
    const qs = u.searchParams, path = u.pathname;
    const out = (v: unknown) => JSON.stringify(v);
    let m: RegExpExecArray | null;

    if (path === "/user") return out({ login: this.login });
    if (path === "/user/repos") return out(this.page([...this.repos.keys()].map((full_name) => ({ full_name, has_issues: true, archived: false })), qs));
    if (path === "/search/issues") {
      const q = qs.get("q") ?? "";
      const repo = /repo:(\S+)/.exec(q)![1]!, text = /(.*?) in:title/.exec(q.replace(/repo:\S+|is:\w+/g, "").trim())?.[1]?.trim().toLowerCase() ?? "";
      const items = [...this.repo(repo).issues.values()].filter((x) => x.title.toLowerCase().includes(text) && (!/is:open/.test(q) || x.state === "open")).map((x) => this.view(repo, x));
      return out({ items });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path))) {
      const repo = m[1]!, rest = m[2]!, r = this.repo(repo);
      if (rest === "milestones") return out(this.page([...r.milestones].map(([number, title]) => ({ number, title })), qs));
      if (rest === "labels" && method === "GET") return out(this.page([...r.labels.values()], qs));
      if (rest === "labels" && method === "POST") {
        if (r.labels.has(body.name.toLowerCase())) this.err(422, "Validation Failed");
        r.labels.set(body.name.toLowerCase(), { name: body.name, color: body.color }); return out(body);
      }
      if (rest === "issues" && method === "GET") {
        const want = (qs.get("labels") ?? "").split(",").filter(Boolean).map((x) => x.toLowerCase());
        let rows = [...r.issues.values()].filter((x) => (qs.get("state") === "all" || (qs.get("state") ?? "open") === x.state) && want.every((l) => x.labels.some((y) => y.toLowerCase() === l)) && (!qs.get("milestone") || x.milestone === Number(qs.get("milestone"))));
        rows = rows.sort((a, b) => (qs.get("sort") === "created" ? a.number - b.number : b.updated - a.updated));
        return out(this.page(rows, qs).map((x) => this.view(repo, x)));
      }
      if ((m = /^issues\/(\d+)(?:\/(labels|comments)(?:\/(.+))?)?$/.exec(rest))) {
        const issue = r.issues.get(Number(m[1])); if (!issue) this.err(404, "Not Found");
        const sub = m[2];
        if (!sub && method === "GET") return out(this.view(repo, issue));
        if (!sub && method === "PATCH") { if (body.state) issue.state = body.state; issue.updated = this.tick++; return out(this.view(repo, issue)); }
        if (sub === "labels" && method === "PUT") { issue.labels = [...body.labels]; for (const l of issue.labels) if (!r.labels.has(l.toLowerCase())) r.labels.set(l.toLowerCase(), { name: l, color: "ededed" }); return out(issue.labels.map((name) => ({ name }))); }
        if (sub === "labels" && method === "POST") { for (const l of body.labels) { if (!issue.labels.includes(l)) issue.labels.push(l); if (!r.labels.has(l.toLowerCase())) r.labels.set(l.toLowerCase(), { name: l, color: "ededed" }); } return out(issue.labels.map((name) => ({ name }))); }
        if (sub === "labels" && method === "DELETE") { const name = decodeURIComponent(m[3]!); if (!issue.labels.includes(name)) this.err(404, "Label does not exist"); issue.labels = issue.labels.filter((x) => x !== name); return out([]); }
        if (sub === "comments" && method === "GET") return out(this.page((r.comments.get(issue.number) ?? []).map((c) => ({ ...c, user: { login: c.user } })), qs));
        if (sub === "comments" && method === "POST") { const list = r.comments.get(issue.number) ?? []; const c = { id: 1000 + list.length, body: body.body, user: this.login, created_at: new Date(0).toISOString() }; list.push(c); r.comments.set(issue.number, list); return out(c); }
      }
    }
    return this.err(404, `Not Found: ${method} ${path}`);
  };
}
