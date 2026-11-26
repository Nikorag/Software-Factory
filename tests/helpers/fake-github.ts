import { GitHubError, type CheckInfo, type GitHubClient, type PrInfo } from "../../src/github/client.js";

/**
 * In-memory GitHub. NOTE what it cannot do: there is no merge method, mirroring the real `GitHubClient`. A "human merge"
 * is simulated only by the test calling `humanMerges()`, which is outside anything the factory can reach.
 */
export class FakeGitHub implements GitHubClient {
  prs: PrInfo[] = [];
  created: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  comments: string[] = [];
  calls: string[] = [];
  /** Each poll of checks() consumes the next entry (the last one repeats). */
  checkPolls: CheckInfo[][] = [[]];
  logs: Record<string, string> = {};
  failures: { method: string; times: number; error: GitHubError }[] = [];
  mergeable = "MERGEABLE";
  /** Test-only: once this returns true GitHub reports the PR mergeable (e.g. after the factory resolved the conflicts). */
  mergeableWhen?: () => boolean;
  private poll = 0;

  private maybeFail(method: string) {
    const f = this.failures.find((x) => x.method === method && x.times > 0);
    if (f) { f.times--; throw f.error; }
  }
  async findPr(_repo: string, head: string) { this.calls.push("findPr"); this.maybeFail("findPr"); return this.prs.filter((p) => p.headRefName === head).sort((a, b) => b.number - a.number)[0] ?? null; }
  async createPr(repo: string, o: { head: string; base: string; title: string; body: string }) {
    this.calls.push("createPr"); this.maybeFail("createPr");
    this.created.push({ repo, ...o });
    const pr: PrInfo = { number: this.prs.length + 1, url: `https://github.com/${repo}/pull/${this.prs.length + 1}`, title: o.title, state: "OPEN", isDraft: false, headRefName: o.head, headRefOid: "abc", baseRefName: o.base, mergedAt: null, mergeable: this.mergeable, mergeStateStatus: "CLEAN", reviewDecision: "" };
    this.prs.push(pr);
    return pr;
  }
  async getPr(_repo: string, number: number) { this.calls.push("getPr"); this.maybeFail("getPr"); const p = this.prs.find((x) => x.number === number); if (!p) throw new GitHubError("not found", false); return { ...p, mergeable: p.state === "OPEN" ? (this.mergeableWhen?.() ? "MERGEABLE" : this.mergeable) : p.mergeable }; }
  async checks(_repo: string, _n: number) { this.calls.push("checks"); this.maybeFail("checks"); const r = this.checkPolls[Math.min(this.poll, this.checkPolls.length - 1)]!; this.poll++; return r; }
  async failedLog(_repo: string, c: CheckInfo) { return this.logs[c.name] ?? ""; }
  async commentOnPr(_repo: string, _n: number, body: string) { this.comments.push(body); }

  /** Test-only: what a person does in the GitHub UI. */
  humanMerges(number = 1) { const p = this.prs.find((x) => x.number === number)!; p.state = "MERGED"; p.mergedAt = new Date().toISOString(); }
  humanCloses(number = 1) { this.prs.find((x) => x.number === number)!.state = "CLOSED"; }
}

export const check = (name: string, bucket: CheckInfo["bucket"], workflow = "CI", link = "https://github.com/o/r/actions/runs/1/job/2"): CheckInfo => ({ name, workflow, bucket, state: bucket.toUpperCase(), link });
