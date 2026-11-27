import { execFile } from "node:child_process";
import { ghEnv } from "../repo/gh.js";

export interface PrInfo {
  number: number; url: string; title: string; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean;
  headRefName: string; headRefOid: string; baseRefName: string; mergedAt: string | null;
  mergeable: string; mergeStateStatus: string; reviewDecision: string;
}
export type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
/**
 * A comment on a pull request: in the conversation (`ic:`), inline on the diff (`rc:`, with its file and line) or a review's summary (`rv:`).
 * `association` is GitHub's author_association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE...), used to decide whose instructions count.
 */
export interface PrComment { id: string; author: string; association: string; body: string; url: string; path: string | null; line: number | null; createdAt: string }
export interface CheckInfo { name: string; workflow: string; bucket: Bucket; state: string; link: string }

/** Everything delivery needs from GitHub. Note what is absent: there is no merge operation. The factory never merges. */
export interface GitHubClient {
  findPr(repo: string, head: string): Promise<PrInfo | null>;
  createPr(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;
  getPr(repo: string, number: number): Promise<PrInfo>;
  checks(repo: string, number: number): Promise<CheckInfo[]>;
  /** Best-effort tail of a failed check's log, for the remediation agent. */
  failedLog(repo: string, check: CheckInfo): Promise<string>;
  commentOnPr(repo: string, number: number, body: string): Promise<void>;
  /** Every comment on the PR (conversation, inline and review summaries), oldest first. */
  prComments(repo: string, number: number): Promise<PrComment[]>;
}

export class GitHubError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "GitHubError";
  }
}

const PR_FIELDS = "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,mergedAt,mergeable,mergeStateStatus,reviewDecision";
export type GhExec = (args: string[], o: { env: NodeJS.ProcessEnv; input?: string }) => Promise<string>;

export const defaultExec: GhExec = (args, o) => new Promise((resolve, reject) => {
  const child = execFile("gh", args, { env: o.env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  child.stdin?.end(o.input ?? "");
});

const asPr = (j: Record<string, unknown>): PrInfo => ({
  number: Number(j.number), url: String(j.url), title: String(j.title ?? ""), state: j.state as PrInfo["state"], isDraft: Boolean(j.isDraft),
  headRefName: String(j.headRefName), headRefOid: String(j.headRefOid ?? ""), baseRefName: String(j.baseRefName), mergedAt: (j.mergedAt as string) || null,
  mergeable: String(j.mergeable ?? "UNKNOWN"), mergeStateStatus: String(j.mergeStateStatus ?? "UNKNOWN"), reviewDecision: String(j.reviewDecision ?? ""),
});

/** Network/rate problems are retryable; auth and "not found" are not. */
export function classify(e: unknown): GitHubError {
  const msg = `${(e as { stderr?: string }).stderr ?? ""} ${(e as Error).message}`.trim();
  // GitHub's own "Something went wrong while executing your query" (seen live on `pr create`) is a server-side fault: retry it.
  const transient = /timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|\b50[0234]\b|rate limit|secondary rate|could not resolve host|connection reset|something went wrong|internal server error|temporarily unavailable|try again/i.test(msg);
  return new GitHubError(msg.replace(/gh[pousr]_[A-Za-z0-9]+/g, "[REDACTED]").slice(0, 500), transient);
}

/** `gh` as a specific account (its token goes only into the child's environment). */
export function createGhClient(opts: { account?: string; run?: GhExec } = {}): GitHubClient {
  const run = opts.run ?? defaultExec;
  const gh = async (args: string[]): Promise<string> => {
    try { return await run(args, { env: await ghEnv(opts.account) }); } catch (e) { throw classify(e); }
  };
  const view = async (repo: string, sel: string): Promise<PrInfo> => asPr(JSON.parse(await gh(["pr", "view", sel, "--repo", repo, "--json", PR_FIELDS])));
  return {
    async findPr(repo, head) {
      const list = JSON.parse(await gh(["pr", "list", "--repo", repo, "--head", head, "--state", "all", "--limit", "5", "--json", PR_FIELDS])) as Record<string, unknown>[];
      const prs = list.map(asPr).filter((p) => p.headRefName === head);
      return prs.find((p) => p.state === "OPEN") ?? prs[0] ?? null; // prefer the open one
    },
    async createPr(repo, o) {
      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "factory-pr-"));
      const bodyFile = join(dir, "body.md");
      writeFileSync(bodyFile, o.body, { mode: 0o600 });
      let url: string;
      try {
        url = (await gh(["pr", "create", "--repo", repo, "--head", o.head, "--base", o.base, "--title", o.title, "--body-file", bodyFile])).trim().split("\n").at(-1)!;
      } catch (e) {
        // Idempotent create. GitHub sometimes creates the PR and still returns an error (seen live), and its list endpoint lags
        // behind, so a retry (or a find-then-create) can hit "already exists": that is success, and the PR URL is in the message.
        const existing = e instanceof GitHubError ? /already exists:?\s*(https:\/\/github\.com\/\S+\/pull\/\d+)/i.exec(e.message)?.[1] : undefined;
        if (!existing) throw e;
        url = existing;
      }
      return view(repo, url);
    },
    getPr: (repo, number) => view(repo, String(number)),
    async checks(repo, number) {
      try {
        const rows = JSON.parse(await gh(["pr", "checks", String(number), "--repo", repo, "--json", "name,state,bucket,link,workflow"])) as Record<string, string>[];
        return rows.map((r) => ({ name: r.name!, workflow: r.workflow ?? "", bucket: r.bucket as Bucket, state: r.state ?? "", link: r.link ?? "" }));
      } catch (e) {
        if (e instanceof GitHubError && /no checks reported/i.test(e.message)) return []; // a repo with no CI: not an error
        throw e;
      }
    },
    async failedLog(repo, check) {
      const m = /\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(check.link);
      if (!m) return "";
      try {
        const out = await gh(["run", "view", m[1]!, "--repo", repo, ...(m[2] ? ["--job", m[2]] : []), "--log-failed"]);
        return out.length > 6000 ? `…${out.slice(-6000)}` : out;
      } catch { return ""; }
    },
    async commentOnPr(repo, number, body) { await gh(["pr", "comment", String(number), "--repo", repo, "--body", body]); },
    async prComments(repo, number) {
      // --paginate with a per-item --jq prints one JSON object per line across every page.
      const lines = async (path: string, jq: string) => (await gh(["api", "--paginate", path, "--jq", `.[] | ${jq}`])).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      const base = "{id, author: .user.login, association: .author_association, body: (.body // \"\"), url: .html_url";
      const [ic, rc, rv] = await Promise.all([
        lines(`repos/${repo}/issues/${number}/comments`, `${base}, createdAt: .created_at}`),
        lines(`repos/${repo}/pulls/${number}/comments`, `${base}, createdAt: .created_at, path, line: (.line // .original_line)}`),
        lines(`repos/${repo}/pulls/${number}/reviews`, `${base}, createdAt: .submitted_at}`),
      ]);
      const as = (prefix: string) => (r: Record<string, unknown>): PrComment => ({ id: `${prefix}:${r.id}`, author: String(r.author ?? ""), association: String(r.association ?? "NONE"), body: String(r.body ?? ""), url: String(r.url ?? ""), path: (r.path as string) ?? null, line: typeof r.line === "number" ? r.line : null, createdAt: String(r.createdAt ?? "") });
      return [...ic.map(as("ic")), ...rc.map(as("rc")), ...rv.map(as("rv"))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}
