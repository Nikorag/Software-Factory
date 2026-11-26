import { defaultExec, type GhExec } from "../github/client.js";
import { ghEnv } from "../repo/gh.js";
import { LinearApiError, type BoardQuery, type IssueQuery, type LinearClient, type LinearComment, type LinearIssue, type LinearIssueDetail, type LinearLabel, type LinearState } from "../linear/client.js";

/**
 * GitHub Issues behind the factory's tracker interface (the one Linear and Jira implement), so discovery, the Board, the outbox and the
 * pipeline need no GitHub-specific code. Mapping of concepts: team = repository ("owner/name"), project = milestone, label = label (a plain
 * string, so its id is its name), workflow status = a label that starts with `statusPrefix` (GitHub issues are only open or closed).
 *
 * Differences handled here:
 *  - A ticket's id is "owner/name#123" (REST needs the repository); its identifier is "name-123", which is safe as a branch/worktree key.
 *  - Moving to the "done" status closes the issue; moving to any other status reopens it. Exactly one status label is kept.
 *  - Comments cannot carry a client id, so the factory's id is embedded as a hidden HTML comment and found again on retry.
 *  - Pull requests share GitHub's issue endpoints; they are filtered out of every listing.
 *  - Authentication is `gh` (the profile's account), exactly as for pull requests.
 */
export interface GithubIssuesOptions {
  account?: string;
  /** The status-label prefix, e.g. "status: ". */
  statusPrefix: string;
  /** The factory's status names by key (readyForSpecification, done, ...): decides each status's type and which one closes an issue. */
  statuses: Record<string, string>;
  run?: GhExec; sleep?: (ms: number) => Promise<void>; maxRetries?: number;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- GitHub JSON, shaped by the REST API

const REF = /software-factory-ref: ([0-9a-f-]{36})/;
const PR_MARK = (url: string) => `<!-- software-factory-pr: ${url} -->`;
const UNSTARTED = new Set(["readyForSpecification", "readyForDevelopment"]);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENC = encodeURIComponent;

/** "owner/name#123" (also accepts "owner/name/123" and a github.com issue URL). */
export function parseIssueRef(ref: string): { repo: string; number: number } {
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\/issues\/|\/)(\d+)$/.exec(ref.trim());
  if (!m) throw new LinearApiError(`"${ref}" is not a GitHub issue reference (expected owner/repo#123)`, false, 400, "BAD_REF");
  return { repo: m[1]!, number: Number(m[2]) };
}
export const issueKeyOf = (repo: string, n: number) => `${repo.split("/")[1]!.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "issue"}-${n}`;

export function createGithubIssuesClient(o: GithubIssuesOptions): LinearClient {
  const run = o.run ?? defaultExec;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 3;
  const prefix = o.statusPrefix;
  const doneName = o.statuses.done ?? "";
  const isStatusLabel = (n: string) => n.toLowerCase().startsWith(prefix.toLowerCase());
  const statusOf = (n: string) => n.slice(prefix.length);
  const typeOfName = (name: string): string => {
    const key = Object.entries(o.statuses).find(([, v]) => v && v.toLowerCase() === name.toLowerCase())?.[0];
    return key === "done" ? "completed" : key && UNSTARTED.has(key) ? "unstarted" : key ? "started" : "unstarted";
  };

  /** One REST call through `gh api`. Retries transient failures; turns the rest into LinearApiError. */
  async function api<T = Raw>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", path, ...(body !== undefined ? ["--input", "-"] : [])];
        const out = await run(args, { env: await ghEnv(o.account), ...(body !== undefined ? { input: JSON.stringify(body) } : {}) });
        return (out.trim() ? JSON.parse(out) : {}) as T;
      } catch (e) {
        if (e instanceof LinearApiError) throw e;
        const msg = `${(e as { stderr?: string }).stderr ?? ""} ${(e as Error).message}`.replace(/gh[pousr]_[A-Za-z0-9]+/g, "[REDACTED]").trim();
        const status = Number(/HTTP (\d{3})/.exec(msg)?.[1]) || undefined;
        const limited = /rate limit|secondary rate|abuse/i.test(msg);
        const transient = limited || (status !== undefined && status >= 500) || /timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|could not resolve host|connection reset|temporarily unavailable/i.test(msg);
        if (transient && attempt < maxRetries) { await sleep(Math.min(500 * 2 ** attempt, 30_000)); continue; }
        const auth = !limited && (status === 401 || status === 403 || /gh auth login|authentication|no login for account/i.test(msg));
        throw new LinearApiError(`GitHub ${method} ${path.split("?")[0]} failed${status ? ` (${status})` : ""}: ${msg.slice(0, 300)}`, transient, status, auth ? "AUTH" : status === 404 ? "NOT_FOUND" : undefined);
      }
    }
  }
  /** A list endpoint, every page (100 at a time) up to `limit` items. */
  async function list(path: string, limit = 1000): Promise<Raw[]> {
    const out: Raw[] = [];
    for (let page = 1; out.length < limit; page++) {
      const rows = await api<Raw[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out.slice(0, limit);
  }

  const stateOf = (r: Raw): LinearState => {
    const names = (r.labels ?? []).map((l: Raw) => String(typeof l === "string" ? l : l.name)).filter(isStatusLabel);
    if (names.length) { const n = statusOf(names[0]!); return { id: n, name: n, type: typeOfName(n) }; }
    if (r.state === "closed") return { id: doneName || "Closed", name: doneName || "Closed", type: "completed" };
    return { id: "Open", name: "Open", type: "unstarted" };
  };
  const toIssue = (repo: string, r: Raw): LinearIssue => ({
    id: `${repo}#${r.number}`, identifier: issueKeyOf(repo, r.number), title: r.title ?? "", description: r.body ?? null, url: r.html_url,
    state: stateOf(r), team: { id: repo, key: repo, name: repo },
    project: r.milestone ? { id: String(r.milestone.number), name: r.milestone.title } : null,
    labels: (r.labels ?? []).map((l: Raw): LinearLabel => ({ id: String(l.name), name: String(l.name) })).filter((l: LinearLabel) => !isStatusLabel(l.name)),
  });
  const notPr = (r: Raw) => !r.pull_request;

  const checkRepo = (repo: string) => { if (!REPO.test(repo)) throw new LinearApiError(`"${repo}" is not a GitHub repository (expected owner/name)`, false, 400, "CONFIG"); };
  async function milestoneNumber(repo: string, a: { projectId?: string; projectName?: string }): Promise<string | undefined> {
    if (a.projectId && /^\d+$/.test(a.projectId)) return a.projectId;
    if (!a.projectName) return undefined;
    const m = (await list(`/repos/${repo}/milestones?state=all`)).find((x) => String(x.title).toLowerCase() === a.projectName!.toLowerCase());
    if (!m) throw new LinearApiError(`GitHub repository ${repo} has no milestone "${a.projectName}"`, false, undefined, "CONFIG");
    return String(m.number);
  }
  async function issues(repo: string, qs: Record<string, string>, limit: number): Promise<LinearIssue[]> {
    checkRepo(repo);
    const out: LinearIssue[] = [];
    for (let page = 1; out.length < limit; page++) {
      const rows = await api<Raw[]>("GET", `/repos/${repo}/issues?${new URLSearchParams({ ...qs, per_page: "100", page: String(page) })}`);
      out.push(...rows.filter(notPr).map((r) => toIssue(repo, r)));
      if (rows.length < 100) break;
    }
    return out.slice(0, limit);
  }

  const client: LinearClient = {
    freeformLabels: true, // a label that does not exist yet is created when it is first added
    async viewer() { const d = await api("GET", "/user"); return { id: String(d.login), name: String(d.login) }; },
    async teams() {
      const repos = await list("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed", 500);
      return repos.filter((r) => r.has_issues !== false && !r.archived).map((r) => ({ id: String(r.full_name), key: String(r.full_name), name: String(r.full_name) }));
    },
    async projects(repo) { checkRepo(repo); return (await list(`/repos/${repo}/milestones?state=open`)).map((m) => ({ id: String(m.number), name: String(m.title) })); },
    async workflowStates(repo) {
      checkRepo(repo);
      const byName = new Map<string, LinearState>();
      for (const l of await list(`/repos/${repo}/labels`)) if (isStatusLabel(l.name)) { const n = statusOf(l.name); if (n) byName.set(n.toLowerCase(), { id: n, name: n, type: typeOfName(n) }); }
      if (doneName && !byName.has(doneName.toLowerCase())) byName.set(doneName.toLowerCase(), { id: doneName, name: doneName, type: "completed" }); // "done" closes the issue: no label needed
      return [...byName.values()];
    },
    async labels(repo) { checkRepo(repo); return (await list(`/repos/${repo}/labels`)).filter((l) => !isStatusLabel(l.name)).map((l) => ({ id: String(l.name), name: String(l.name) })); },
    async listIssues(a: IssueQuery) {
      const milestone = await milestoneNumber(a.teamKey, a);
      const done = Boolean(doneName) && a.stateName.toLowerCase() === doneName.toLowerCase();
      return issues(a.teamKey, { state: done ? "all" : "open", labels: [`${prefix}${a.stateName}`, a.labelName].join(","), sort: "created", direction: "asc", ...(milestone ? { milestone } : {}) }, 500);
    },
    async boardIssues(a: BoardQuery) {
      checkRepo(a.teamKey);
      if (a.number !== undefined) {
        const r = await api<Raw>("GET", `/repos/${a.teamKey}/issues/${a.number}`).catch((e) => { if (e instanceof LinearApiError && e.status === 404) return null; throw e; });
        return r && notPr(r) ? [toIssue(a.teamKey, r)] : [];
      }
      const limit = a.limit ?? 100;
      if (a.title) {
        const q = [`repo:${a.teamKey}`, "is:issue", a.openOnly ? "is:open" : "", ...(a.projectName ? [`milestone:"${a.projectName.replace(/"/g, "")}"`] : []), `${a.title.replace(/["\\]/g, " ")} in:title`].filter(Boolean).join(" ");
        const d = await api<Raw>("GET", `/search/issues?${new URLSearchParams({ q, sort: "updated", order: "desc", per_page: String(Math.min(limit, 100)) })}`);
        return (d.items ?? []).filter(notPr).map((r: Raw) => toIssue(a.teamKey, r)).slice(0, limit);
      }
      const milestone = await milestoneNumber(a.teamKey, a);
      return issues(a.teamKey, { state: a.openOnly ? "open" : "all", sort: "updated", direction: "desc", ...(milestone ? { milestone } : {}) }, limit);
    },
    async getIssue(ref): Promise<LinearIssueDetail> {
      const { repo, number } = parseIssueRef(ref);
      checkRepo(repo);
      const issue = toIssue(repo, await api("GET", `/repos/${repo}/issues/${number}`));
      const comments: LinearComment[] = (await list(`/repos/${repo}/issues/${number}/comments`, 500)).map((c) => ({
        id: REF.exec(c.body ?? "")?.[1] ?? String(c.id), body: c.body ?? "", createdAt: c.created_at, userName: c.user?.login ?? null, // the factory's own comments are found again by their embedded ref
      }));
      return { ...issue, comments };
    },
    async setState(ref, stateId) {
      const { repo, number } = parseIssueRef(ref);
      const cur = await api<Raw>("GET", `/repos/${repo}/issues/${number}`);
      const keep = (cur.labels ?? []).map((l: Raw) => String(l.name)).filter((n: string) => !isStatusLabel(n));
      await api("PUT", `/repos/${repo}/issues/${number}/labels`, { labels: [...keep, `${prefix}${stateId}`] }); // exactly one status label: replaces the whole set in one call
      const done = Boolean(doneName) && stateId.toLowerCase() === doneName.toLowerCase();
      if (done && cur.state !== "closed") await api("PATCH", `/repos/${repo}/issues/${number}`, { state: "closed", state_reason: "completed" });
      if (!done && cur.state === "closed") await api("PATCH", `/repos/${repo}/issues/${number}`, { state: "open" });
    },
    async addLabel(ref, name) { const { repo, number } = parseIssueRef(ref); await api("POST", `/repos/${repo}/issues/${number}/labels`, { labels: [name] }); },
    async removeLabel(ref, name) {
      const { repo, number } = parseIssueRef(ref);
      try { await api("DELETE", `/repos/${repo}/issues/${number}/labels/${ENC(name)}`); }
      catch (e) { if (!(e instanceof LinearApiError && e.status === 404)) throw e; } // already gone: the goal is met
    },
    async createComment(ref, body, id) {
      const { repo, number } = parseIssueRef(ref);
      await api("POST", `/repos/${repo}/issues/${number}/comments`, { body: `${body}\n\n<!-- software-factory-ref: ${id} -->` });
    },
    async linkPullRequest(ref, url, title) {
      const { repo, number } = parseIssueRef(ref);
      const mark = PR_MARK(url);
      const have = await list(`/repos/${repo}/issues/${number}/comments`, 500);
      if (have.some((c) => String(c.body ?? "").includes(mark))) return; // the same PR is linked once
      await api("POST", `/repos/${repo}/issues/${number}/comments`, { body: `Pull request: ${title ? `[${title}](${url})` : url}\n\n${mark}` }); // GitHub also cross-references the PR on the issue's timeline
    },
    async createWorkflowState(repo, name, _type, color) {
      checkRepo(repo);
      await api("POST", `/repos/${repo}/labels`, { name: `${prefix}${name}`, color: color.replace("#", ""), description: "Software Factory workflow status" }).catch((e) => { if (!(e instanceof LinearApiError && e.status === 422)) throw e; }); // 422: it already exists
      return { id: name };
    },
    async createLabel(repo, name, color) {
      checkRepo(repo);
      await api("POST", `/repos/${repo}/labels`, { name, color: color.replace("#", "") }).catch((e) => { if (!(e instanceof LinearApiError && e.status === 422)) throw e; });
      return { id: name };
    },
  };
  return client;
}
