import { LinearApiError, type IssueQuery, type LinearClient, type LinearIssue, type LinearIssueDetail, type LinearState } from "../../src/linear/client.js";

export const STATE_NAMES = ["Backlog", "Ready for specification", "Specification review", "Ready for development", "In progress", "Ready for review", "Changes requested", "Merging", "Done", "Blocked"];
export const LABEL_NAMES = ["factory:enabled", "factory:autonomous", "factory:bugfix", "factory:feature", "factory:maintenance", "factory:blocked"];

/** In-memory Linear for tests. Records every call and can inject failures. */
export class FakeLinear implements LinearClient {
  states: LinearState[] = STATE_NAMES.map((name, i) => ({ id: `st-${i}`, name, type: "unstarted" }));
  labelDefs = LABEL_NAMES.map((name, i) => ({ id: `lb-${i}`, name }));
  issues = new Map<string, LinearIssueDetail>();
  calls: string[] = [];
  failures: { method: string; times: number; error: LinearApiError; storeFirst?: boolean }[] = [];

  addIssue(o: { id?: string; key?: string; state?: string; labels?: string[]; team?: string; project?: string | null }): LinearIssueDetail {
    const n = this.issues.size + 1;
    const id = o.id ?? `iss-${n}`;
    const issue: LinearIssueDetail = {
      id, identifier: o.key ?? `ENG-${n}`, title: `Issue ${n}`, description: "do the thing", url: `https://linear.app/x/issue/${o.key ?? `ENG-${n}`}`,
      state: this.states.find((s) => s.name === (o.state ?? "Ready for specification"))!,
      team: { id: "team-1", key: o.team ?? "ENG", name: "Engineering" },
      project: o.project ? { id: o.project, name: o.project } : null,
      labels: (o.labels ?? ["factory:enabled"]).map((n2) => this.labelDefs.find((l) => l.name === n2)!),
      comments: [],
    };
    this.issues.set(id, issue);
    return issue;
  }
  failOn(method: string, error: LinearApiError, times = 1, storeFirst = false) { this.failures.push({ method, times, error, storeFirst }); }
  private maybeFail(method: string, store?: () => void) {
    const f = this.failures.find((x) => x.method === method && x.times > 0);
    if (f) { f.times--; if (f.storeFirst) store?.(); throw f.error; }
  }
  private rec(s: string) { this.calls.push(s); }

  async viewer() { this.rec("viewer"); return { id: "u1", name: "Test User" }; }
  async teams() { return [{ id: "team-1", key: "ENG", name: "Engineering" }]; }
  async listIssues(q: IssueQuery): Promise<LinearIssue[]> {
    this.rec(`listIssues:${q.teamKey}:${q.projectId ?? "-"}`);
    this.maybeFail("listIssues");
    return [...this.issues.values()].filter((i) =>
      i.team.key === q.teamKey && i.state.name === q.stateName && i.labels.some((l) => l.name === q.labelName) && (!q.projectId || i.project?.id === q.projectId));
  }
  async getIssue(id: string) { this.rec(`getIssue:${id}`); this.maybeFail("getIssue"); const i = this.issues.get(id); if (!i) throw new LinearApiError("not found", false); return structuredClone(i); }
  async workflowStates() { return this.states; }
  async labels() { return this.labelDefs; }
  async setState(id: string, stateId: string) {
    this.rec(`setState:${id}:${this.states.find((s) => s.id === stateId)?.name}`);
    this.maybeFail("setState");
    this.issues.get(id)!.state = this.states.find((s) => s.id === stateId)!;
  }
  async addLabel(id: string, labelId: string) {
    this.rec(`addLabel:${id}:${this.labelDefs.find((l) => l.id === labelId)?.name}`);
    this.maybeFail("addLabel");
    const i = this.issues.get(id)!; if (!i.labels.some((l) => l.id === labelId)) i.labels.push(this.labelDefs.find((l) => l.id === labelId)!);
  }
  async removeLabel(id: string, labelId: string) {
    this.rec(`removeLabel:${id}:${this.labelDefs.find((l) => l.id === labelId)?.name}`);
    const i = this.issues.get(id)!; i.labels = i.labels.filter((l) => l.id !== labelId);
  }
  async createComment(id: string, body: string, commentId: string) {
    this.rec(`createComment:${id}`);
    const issue = this.issues.get(id)!;
    const store = () => { if (!issue.comments.some((c) => c.id === commentId)) issue.comments.push({ id: commentId, body, createdAt: "now", userName: "me" }); };
    this.maybeFail("createComment", store);
    if (issue.comments.some((c) => c.id === commentId)) throw new LinearApiError("duplicate comment id", false);
    store();
  }
  async linkPullRequest(id: string, url: string) { this.rec(`linkPr:${id}:${url}`); this.maybeFail("linkPullRequest"); }
}
