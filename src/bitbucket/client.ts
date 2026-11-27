import { GitHubError, type Bucket, type CheckInfo, type GitHubClient, type PrInfo } from "../github/client.js";
import type { Protection } from "../repo/inspect.js";
import { authHeader, BB_API, type BbCredential } from "./auth.js";

/**
 * Bitbucket Cloud's pull-request side behind the same interface the GitHub client implements, so delivery needs no Bitbucket-specific code.
 * Like the GitHub client it has no merge operation: the factory never merges.
 */
export interface BitbucketClient extends GitHubClient {
  /** Read-only: does this repository exist and can this credential see it? */
  repository(repo: string): Promise<{ name: string; isPrivate: boolean; mainBranch: string | null }>;
  /** Branch protection as Bitbucket models it (branch restrictions). */
  protection(repo: string, branch: string): Promise<Protection>;
}
export interface BitbucketClientOptions { credential: BbCredential; apiBase?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxRetries?: number }

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Bitbucket JSON

const STATE: Record<string, PrInfo["state"]> = { OPEN: "OPEN", MERGED: "MERGED", DECLINED: "CLOSED", SUPERSEDED: "CLOSED" };
const BUCKET: Record<string, Bucket> = { SUCCESSFUL: "pass", FAILED: "fail", INPROGRESS: "pending", STOPPED: "cancel" };

const asPr = (j: Raw): PrInfo => {
  const people: Raw[] = j.participants ?? [];
  const decision = people.some((p) => p.state === "changes_requested") ? "CHANGES_REQUESTED" : people.some((p) => p.approved || p.state === "approved") ? "APPROVED" : "";
  return {
    number: Number(j.id), url: String(j.links?.html?.href ?? ""), title: String(j.title ?? ""), state: STATE[String(j.state)] ?? "OPEN", isDraft: Boolean(j.draft),
    headRefName: String(j.source?.branch?.name ?? ""), headRefOid: String(j.source?.commit?.hash ?? ""), baseRefName: String(j.destination?.branch?.name ?? ""),
    mergedAt: j.state === "MERGED" ? String(j.updated_on ?? "") || null : null,
    // Bitbucket's pull request has no mergeable flag: conflicts show in its UI. UNKNOWN never blocks (only CONFLICTING does).
    mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", reviewDecision: decision,
  };
};

const glob = (pattern: string, branch: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(branch);

export function createBitbucketClient(o: BitbucketClientOptions): BitbucketClient {
  const f = o.fetch ?? fetch;
  const base = o.apiBase ?? BB_API;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 3;

  async function call(path: string, init: { method?: string; body?: unknown; text?: boolean } = {}): Promise<{ status: number; json: Raw; text: string }> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(`${base}${path}`, {
          method: init.method ?? "GET", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: authHeader(o.credential), Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } catch (e) {
        if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
        throw new GitHubError(`Bitbucket is unreachable: ${(e as Error).message}`, true);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) { await sleep(Math.min((Number(res.headers.get("retry-after")) || 0) * 1000 || 500 * 2 ** attempt, 30_000)); continue; }
      const text = await res.text();
      let json: Raw = {};
      try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON (a log) */ }
      return { status: res.status, json, text };
    }
  }
  const must = async (path: string, init?: { method?: string; body?: unknown }): Promise<Raw> => {
    const r = await call(path, init);
    if (r.status >= 200 && r.status < 300) return r.json;
    const detail = r.json.error?.message ?? r.json.error?.detail ?? r.text.slice(0, 200);
    const hint = r.status === 401 ? " (the token was rejected or has expired: update the credential in Settings → Integrations → Bitbucket)" : r.status === 403 ? " (the token lacks the permission: it needs repository read and write and pull request read and write)" : "";
    throw new GitHubError(`Bitbucket ${init?.method ?? "GET"} ${path.split("?")[0]} failed (${r.status}): ${detail}${hint}`, r.status === 429 || r.status >= 500);
  };
  const prs = (repo: string) => `/repositories/${repo}/pullrequests`;

  const client: BitbucketClient = {
    async findPr(repo, head) {
      const q = new URLSearchParams({ q: `source.branch.name="${head.replace(/"/g, '\\"')}"`, pagelen: "5" });
      for (const s of ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]) q.append("state", s);
      const list = ((await must(`${prs(repo)}?${q}`)).values ?? []).map(asPr).filter((p: PrInfo) => p.headRefName === head);
      return list.find((p: PrInfo) => p.state === "OPEN") ?? list[0] ?? null;
    },
    async createPr(repo, p) {
      try {
        return asPr(await must(prs(repo), { method: "POST", body: { title: p.title, description: p.body, source: { branch: { name: p.head } }, destination: { branch: { name: p.base } }, close_source_branch: false } }));
      } catch (e) {
        // Idempotent create: a retry after the request actually succeeded finds the PR that already exists.
        if (e instanceof GitHubError && /already.*pull request|pull request.*already/i.test(e.message)) { const existing = await client.findPr(repo, p.head); if (existing) return existing; }
        throw e;
      }
    },
    async getPr(repo, number) { return asPr(await must(`${prs(repo)}/${number}`)); },
    async checks(repo, number) {
      const rows: Raw[] = (await must(`${prs(repo)}/${number}/statuses?pagelen=100`)).values ?? [];
      return rows.map((r): CheckInfo => ({ name: String(r.name || r.key || "build"), workflow: String(r.key ?? ""), bucket: BUCKET[String(r.state)] ?? "pending", state: String(r.state ?? ""), link: String(r.url ?? "") }));
    },
    async failedLog(repo, check) {
      // Best effort: a failed Pipelines step's log. Anything that does not line up returns "" and remediation simply has no log.
      try {
        const build = /\/pipelines\/results\/(\d+)/.exec(check.link)?.[1];
        if (!build) return "";
        const list: Raw[] = (await must(`/repositories/${repo}/pipelines?sort=-created_on&pagelen=50`)).values ?? [];
        const pipeline = list.find((p) => String(p.build_number) === build);
        if (!pipeline) return "";
        const steps: Raw[] = (await must(`/repositories/${repo}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps`)).values ?? [];
        const bad = steps.find((s) => s.state?.result?.name === "FAILED") ?? steps.at(-1);
        if (!bad) return "";
        const log = await call(`/repositories/${repo}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps/${encodeURIComponent(bad.uuid)}/log`);
        return log.status === 200 ? (log.text.length > 6000 ? `…${log.text.slice(-6000)}` : log.text) : "";
      } catch { return ""; }
    },
    async commentOnPr(repo, number, body) { await must(`${prs(repo)}/${number}/comments`, { method: "POST", body: { content: { raw: body } } }); },
    // Not yet: Bitbucket comments carry no equivalent of GitHub's author_association, so the factory cannot tell whether a commenter
    // may instruct it. Bitbucket projects take change requests from the job page only.
    async prComments() { return []; },
    async repository(repo) { const j = await must(`/repositories/${repo}`); return { name: String(j.full_name ?? repo), isPrivate: Boolean(j.is_private), mainBranch: j.mainbranch?.name ?? null }; },
    async protection(repo, branch): Promise<Protection> {
      const r = await call(`/repositories/${repo}`);
      if (r.status !== 200) return { status: "unknown", reason: `repository ${repo} is not accessible to this Bitbucket credential (HTTP ${r.status})` };
      const res = await call(`/repositories/${repo}/branch-restrictions?pagelen=100`);
      if (res.status === 403 || res.status === 401) return { status: "unavailable", reason: "this credential cannot read branch restrictions (it needs the repository admin permission)" };
      if (res.status !== 200) return { status: "unknown", reason: `Bitbucket returned ${res.status} for branch restrictions` };
      const mine: Raw[] = (res.json.values ?? []).filter((x: Raw) => (x.pattern ? glob(String(x.pattern), branch) : x.branch_match_kind === "branching_model"));
      const PROTECTING = new Set(["push", "force", "delete", "restrict_merges", "require_passing_builds_to_merge", "require_approvals_to_merge", "require_default_reviewer_approvals_to_merge", "require_tasks_to_be_completed"]);
      const active = mine.filter((x) => PROTECTING.has(String(x.kind)));
      if (!active.length) return { status: "unprotected" };
      return { status: "protected", requiredChecks: active.some((x) => x.kind === "require_passing_builds_to_merge") ? ["passing builds"] : [], requiresReviews: active.some((x) => /approvals/.test(String(x.kind))) };
    },
  };
  return client;
}
