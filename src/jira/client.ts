import { LinearApiError, type BoardQuery, type IssueQuery, type LinearClient, type LinearComment, type LinearIssue, type LinearIssueDetail, type LinearLabel, type LinearState } from "../linear/client.js";
import { ATLASSIAN_API, type JiraAuth } from "./auth.js";
import { adfToText, markdownToAdf } from "./adf.js";

/**
 * Jira Cloud behind the factory's tracker interface (the same one Linear implements), so discovery, the Board, the outbox and the
 * pipeline need no Jira-specific code. Mapping of concepts: Linear team = Jira project (key), Linear project = Jira component,
 * workflow state = Jira status, label = Jira label (a plain string, so its id is its name).
 *
 * Jira differences handled here: statuses cannot be created (and moving a ticket needs a workflow TRANSITION that must exist from its
 * current status), comments cannot carry a client id (so the factory's id is embedded in the comment text and found again on retry),
 * and rich text is ADF.
 */
export interface JiraClientOptions {
  auth: JiraAuth; cloudId: string; siteUrl: string;
  apiBase?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxRetries?: number; timeoutMs?: number;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Jira JSON, shaped by our own field lists

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; // JQL string literal
const FIELDS = "summary,description,status,project,labels,components";
const REF = /Software Factory ref: ([0-9a-f-]{36})/;
const TYPE_OF: Record<string, string> = { new: "unstarted", indeterminate: "started", done: "completed" };

export function createJiraClient(o: JiraClientOptions): LinearClient {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = `${o.apiBase ?? ATLASSIAN_API}/ex/jira/${o.cloudId}`;
  const maxRetries = o.maxRetries ?? 3;

  async function request<T = Raw>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(`${base}${path}`, {
          method: init.method ?? "GET", signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
          headers: { Authorization: `Bearer ${await o.auth.accessToken()}`, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } catch (e) {
        if (e instanceof LinearApiError) throw e;
        if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
        throw new LinearApiError(`Jira is unreachable: ${(e as Error).message}`, true);
      }
      if (res.status === 401 && !refreshed) { refreshed = true; await o.auth.accessToken(true); continue; } // the token was revoked or expired early
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(Math.min((Number(res.headers.get("retry-after")) || 0) * 1000 || 500 * 2 ** attempt, 30_000));
        continue;
      }
      if (res.status === 204) return {} as T;
      const text = await res.text();
      let json: Raw = {};
      try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
      if (!res.ok) {
        const detail = [...(json.errorMessages ?? []), ...Object.values(json.errors ?? {})].join("; ") || text.slice(0, 200);
        throw new LinearApiError(`Jira ${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${detail}`, res.status === 429 || res.status >= 500, res.status, res.status === 401 || res.status === 403 ? "AUTH" : undefined);
      }
      return json as T;
    }
  }

  const stateOf = (st: Raw): LinearState => ({ id: String(st.id), name: st.name, type: TYPE_OF[st.statusCategory?.key] ?? "unstarted" });
  const toIssue = (r: Raw): LinearIssue => {
    const f2 = r.fields ?? {};
    const comps = (f2.components ?? []).map((c: Raw) => ({ id: String(c.id), name: c.name }));
    return {
      id: String(r.id), identifier: r.key, title: f2.summary ?? "", description: f2.description ? adfToText(f2.description) : null,
      url: `${o.siteUrl.replace(/\/$/, "")}/browse/${r.key}`, state: stateOf(f2.status ?? {}),
      team: { id: String(f2.project?.id ?? ""), key: f2.project?.key ?? "", name: f2.project?.name ?? "" },
      project: comps[0] ?? null, projects: comps,
      labels: (f2.labels ?? []).map((l: string): LinearLabel => ({ id: l, name: l })),
    };
  };

  async function search(jql: string, limit: number): Promise<LinearIssue[]> {
    const out: LinearIssue[] = [];
    let token: string | undefined;
    do {
      const d = await request(`/rest/api/3/search/jql?${new URLSearchParams({ jql, fields: FIELDS, maxResults: String(Math.min(100, limit - out.length)), ...(token ? { nextPageToken: token } : {}) })}`);
      out.push(...(d.issues ?? []).map(toIssue));
      token = d.isLast === false || d.nextPageToken ? d.nextPageToken : undefined;
    } while (token && out.length < limit);
    return out;
  }
  const scope = (a: { teamKey: string; projectName?: string; projectId?: string }) => [`project = ${q(a.teamKey)}`, ...(a.projectName ? [`component = ${q(a.projectName)}`] : a.projectId ? [`component = ${a.projectId.replace(/\D/g, "") || 0}`] : [])];

  const client: LinearClient = {
    freeformLabels: true,
    async viewer() { const d = await request("/rest/api/3/myself"); return { id: d.accountId, name: d.displayName ?? d.emailAddress ?? d.accountId }; },
    async teams() {
      const out: { id: string; key: string; name: string }[] = [];
      for (let start = 0; ; ) {
        const d = await request(`/rest/api/3/project/search?startAt=${start}&maxResults=50`);
        out.push(...(d.values ?? []).map((p: Raw) => ({ id: String(p.id), key: p.key, name: p.name })));
        start += (d.values ?? []).length;
        if (d.isLast !== false || !(d.values ?? []).length) break;
      }
      return out;
    },
    async projects(teamId) { return ((await request<Raw[]>(`/rest/api/3/project/${encodeURIComponent(teamId)}/components`)) as unknown as Raw[]).map((c) => ({ id: String(c.id), name: c.name })); },
    async workflowStates(teamId) {
      const byName = new Map<string, LinearState>();
      for (const type of ((await request<Raw[]>(`/rest/api/3/project/${encodeURIComponent(teamId)}/statuses`)) as unknown as Raw[])) for (const st of type.statuses ?? []) if (!byName.has(String(st.name).toLowerCase())) byName.set(String(st.name).toLowerCase(), stateOf(st));
      return [...byName.values()];
    },
    async labels() {
      const out: LinearLabel[] = [];
      for (let start = 0; ; ) {
        const d = await request(`/rest/api/3/label?startAt=${start}&maxResults=1000`);
        out.push(...(d.values ?? []).map((n: string) => ({ id: n, name: n })));
        start += (d.values ?? []).length;
        if (d.isLast !== false || !(d.values ?? []).length) break;
      }
      return out;
    },
    async listIssues(a: IssueQuery) {
      return search([...scope(a), `status = ${q(a.stateName)}`, `labels = ${q(a.labelName)}`].join(" AND ") + " ORDER BY created ASC", 500);
    },
    async boardIssues(a: BoardQuery) {
      const parts = [...scope(a)];
      if (a.openOnly) parts.push("statusCategory != Done");
      if (a.number !== undefined) parts.push(`key = ${q(`${a.teamKey}-${a.number}`)}`);
      if (a.title) parts.push(`summary ~ ${q(a.title)}`);
      return search(`${parts.join(" AND ")} ORDER BY updated DESC`, a.limit ?? 100);
    },
    async getIssue(idOrKey): Promise<LinearIssueDetail> {
      const issue = toIssue(await request(`/rest/api/3/issue/${encodeURIComponent(idOrKey)}?fields=${FIELDS}`));
      const d = await request(`/rest/api/3/issue/${encodeURIComponent(idOrKey)}/comment?maxResults=100&orderBy=created`);
      const comments: LinearComment[] = (d.comments ?? []).map((c: Raw) => {
        const body = adfToText(c.body);
        return { id: REF.exec(body)?.[1] ?? String(c.id), body, createdAt: c.created, userName: c.author?.displayName ?? null }; // the factory's own comments are found again by their embedded ref
      });
      return { ...issue, comments };
    },
    async setState(issueId, stateId) {
      const d = await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`);
      const t = (d.transitions ?? []).find((x: Raw) => String(x.to?.id) === stateId);
      if (!t) {
        const now = (await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=status`)).fields?.status?.name;
        const to = ((await client.workflowStates(String((await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=project`)).fields?.project?.id)).catch(() => []))).find((s) => s.id === stateId)?.name ?? stateId;
        throw new LinearApiError(`Jira has no workflow transition to "${to}" from this ticket's current status "${now}". Your workflow does not allow that move: map this status to a different one (Settings → Tracker) or add the transition in Jira.`, false, undefined, "NO_TRANSITION");
      }
      await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`, { method: "POST", body: { transition: { id: t.id } } });
    },
    addLabel: async (issueId, labelId) => { await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}`, { method: "PUT", body: { update: { labels: [{ add: labelId }] } } }); },
    removeLabel: async (issueId, labelId) => { await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}`, { method: "PUT", body: { update: { labels: [{ remove: labelId }] } } }); },
    async createComment(issueId, body, id) {
      await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, { method: "POST", body: { body: markdownToAdf(`${body}\n\nSoftware Factory ref: ${id}`) } });
    },
    async linkPullRequest(issueId, url, title) {
      await request(`/rest/api/3/issue/${encodeURIComponent(issueId)}/remotelink`, { method: "POST", body: { globalId: `software-factory-pr:${url}`, object: { url, title: title ?? "Pull request" } } }); // same globalId = updated, not duplicated
    },
    async createWorkflowState(): Promise<{ id: string }> { throw new LinearApiError("Jira statuses are owned by your Jira admins: map the factory's statuses to existing ones instead (Settings → Tracker)", false, undefined, "UNSUPPORTED"); },
    async createLabel(_teamId, name) { return { id: name }; }, // a Jira label exists as soon as it is used
  };
  return client;
}
