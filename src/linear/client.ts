export interface LinearLabel { id: string; name: string }
export interface LinearState { id: string; name: string; type: string }
export interface LinearComment { id: string; body: string; createdAt: string; userName: string | null }
export interface LinearIssue {
  id: string;
  identifier: string; // e.g. ENG-123
  title: string;
  description: string | null;
  url: string;
  state: LinearState;
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  labels: LinearLabel[];
}
export interface LinearIssueDetail extends LinearIssue { comments: LinearComment[] }
/** What the Board asks for: a team (optionally one project), either open tickets or a search by ticket number / title. */
export interface BoardQuery { teamKey: string; projectId?: string; projectName?: string; number?: number; title?: string; openOnly?: boolean; limit?: number }
export interface IssueQuery { teamKey: string; projectId?: string; projectName?: string; stateName: string; labelName: string }

/** Everything the factory needs from Linear. Real implementation below; tests supply a fake. */
export interface LinearClient {
  viewer(): Promise<{ id: string; name: string }>;
  listIssues(q: IssueQuery): Promise<LinearIssue[]>;
  getIssue(idOrKey: string): Promise<LinearIssueDetail>;
  /** Read-only: tickets for the Board and its search. Never writes. */
  boardIssues(q: BoardQuery): Promise<LinearIssue[]>;
  workflowStates(teamId: string): Promise<LinearState[]>;
  /** Workspace-level labels plus those belonging to the team. */
  labels(teamId: string): Promise<LinearLabel[]>;
  teams(): Promise<{ id: string; key: string; name: string }[]>;
  projects(teamId: string): Promise<{ id: string; name: string }[]>;
  setState(issueId: string, stateId: string): Promise<void>;
  addLabel(issueId: string, labelId: string): Promise<void>;
  removeLabel(issueId: string, labelId: string): Promise<void>;
  /** `id` is client-chosen (a UUID) so retries cannot create duplicates. */
  createComment(issueId: string, body: string, id: string): Promise<void>;
  linkPullRequest(issueId: string, url: string, title?: string): Promise<void>;
  /** Used only by `linear:setup`. Creates; never edits or deletes. `type` is one of triage|backlog|unstarted|started|completed|canceled. */
  createWorkflowState(teamId: string, name: string, type: string, color: string): Promise<{ id: string }>;
  /** Team-scoped label (visible only in that team). */
  createLabel(teamId: string, name: string, color: string): Promise<{ id: string }>;
}

export class LinearApiError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "LinearApiError";
  }
}

export interface HttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

const ISSUE_FIELDS = `id identifier title description url
  state { id name type } team { id key name } project { id name } labels { nodes { id name } }`;

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- GraphQL JSON, shaped by our own queries

const toIssue = (n: Raw): LinearIssue => ({
  id: n.id, identifier: n.identifier, title: n.title, description: n.description ?? null, url: n.url,
  state: n.state, team: n.team, project: n.project ?? null, labels: n.labels?.nodes ?? [],
});

export function createLinearClient(opts: HttpClientOptions): LinearClient {
  const url = opts.baseUrl ?? "https://api.linear.app/graphql";
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;

  async function request<T = Raw>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let wait = Math.min(1000 * 2 ** attempt, 30_000);
      let failure: LinearApiError;
      try {
        const res = await doFetch(url, {
          method: "POST",
          // Personal API keys are sent as-is (no "Bearer" prefix).
          headers: { "Content-Type": "application/json", Authorization: opts.apiKey },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
        const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
        const code = body.errors?.[0]?.extensions?.code;
        if (res.status === 401 || res.status === 403 || code === "AUTHENTICATION_ERROR") {
          throw new LinearApiError("Linear rejected the API key (check LINEAR_API_KEY)", false, res.status, code);
        }
        if (res.status === 429 || code === "RATELIMITED") {
          const reset = Number(res.headers.get("x-ratelimit-requests-reset")); // epoch ms
          if (reset > Date.now()) wait = Math.min(reset - Date.now() + 250, 60_000);
          failure = new LinearApiError("Linear rate limit hit", true, res.status, "RATELIMITED");
        } else if (res.status >= 500) {
          failure = new LinearApiError(`Linear server error (HTTP ${res.status})`, true, res.status);
        } else if (body.errors?.length || !res.ok || !body.data) {
          const msg = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
          throw new LinearApiError(`Linear API error: ${msg}`, false, res.status, code);
        } else {
          return body.data;
        }
      } catch (e) {
        if (e instanceof LinearApiError && !e.retryable) throw e;
        failure = e instanceof LinearApiError ? e : new LinearApiError(`Linear request failed: ${(e as Error).message}`, true); // network/timeout
      }
      if (attempt >= maxRetries) throw failure;
      await sleep(wait);
    }
  }

  const mutate = async (query: string, vars: Record<string, unknown>, field: string) => {
    const data = await request<Raw>(query, vars);
    if (!data[field]?.success) throw new LinearApiError(`Linear mutation ${field} reported failure`, false);
  };

  return {
    async viewer() {
      const d = await request<Raw>("query { viewer { id name } }");
      return d.viewer;
    },
    async teams() {
      const d = await request<Raw>("query { teams(first: 100) { nodes { id key name } } }");
      return d.teams.nodes;
    },
    async projects(teamId) {
      const d = await request<Raw>(`query($id: String!) { team(id: $id) { projects(first: 100) { nodes { id name } } } }`, { id: teamId });
      return d.team.projects.nodes;
    },
    async listIssues(q) {
      const filter: Raw = {
        team: { key: { eq: q.teamKey } },
        state: { name: { eq: q.stateName } },
        labels: { some: { name: { eq: q.labelName } } },
      };
      if (q.projectId) filter.project = { id: { eq: q.projectId } };
      else if (q.projectName) filter.project = { name: { eq: q.projectName } };
      const out: LinearIssue[] = [];
      let after: string | null = null;
      do {
        const d: Raw = await request(
          `query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 50, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
          { filter, after },
        );
        out.push(...d.issues.nodes.map(toIssue));
        after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
      } while (after);
      return out;
    },
    async boardIssues(q) {
      const filter: Raw = { team: { key: { eq: q.teamKey } } };
      if (q.projectId) filter.project = { id: { eq: q.projectId } };
      else if (q.projectName) filter.project = { name: { eq: q.projectName } };
      if (q.openOnly) filter.state = { type: { nin: ["completed", "canceled"] } };
      if (q.number !== undefined) filter.number = { eq: q.number };
      if (q.title) filter.title = { containsIgnoreCase: q.title };
      const d = await request<Raw>(
        `query($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`,
        { filter, first: Math.min(q.limit ?? 100, 100) },
      );
      return d.issues.nodes.map(toIssue);
    },
    async getIssue(idOrKey) {
      const d = await request<Raw>(
        `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} comments(first: 100) { nodes { id body createdAt user { name } } } } }`,
        { id: idOrKey },
      );
      if (!d.issue) throw new LinearApiError(`issue ${idOrKey} not found`, false);
      return { ...toIssue(d.issue), comments: d.issue.comments.nodes.map((c: Raw) => ({ id: c.id, body: c.body, createdAt: c.createdAt, userName: c.user?.name ?? null })) };
    },
    async workflowStates(teamId) {
      const d = await request<Raw>(
        `query($teamId: ID) { workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name type } } }`,
        { teamId },
      );
      return d.workflowStates.nodes;
    },
    async labels(teamId) {
      const out: (LinearLabel & { teamId: string | null })[] = [];
      let after: string | null = null;
      do {
        const d: Raw = await request(
          `query($after: String) { issueLabels(first: 100, after: $after) { nodes { id name team { id } } pageInfo { hasNextPage endCursor } } }`,
          { after },
        );
        out.push(...d.issueLabels.nodes.map((n: Raw) => ({ id: n.id, name: n.name, teamId: n.team?.id ?? null })));
        after = d.issueLabels.pageInfo.hasNextPage ? d.issueLabels.pageInfo.endCursor : null;
      } while (after);
      return out.filter((l) => l.teamId === null || l.teamId === teamId).map(({ id, name }) => ({ id, name }));
    },
    setState: (issueId, stateId) =>
      mutate(`mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, { id: issueId, stateId }, "issueUpdate"),
    addLabel: (issueId, labelId) =>
      mutate(`mutation($id: String!, $l: String!) { issueUpdate(id: $id, input: { addedLabelIds: [$l] }) { success } }`, { id: issueId, l: labelId }, "issueUpdate"),
    removeLabel: (issueId, labelId) =>
      mutate(`mutation($id: String!, $l: String!) { issueUpdate(id: $id, input: { removedLabelIds: [$l] }) { success } }`, { id: issueId, l: labelId }, "issueUpdate"),
    createComment: (issueId, body, id) =>
      mutate(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body, id } }, "commentCreate"),
    async createWorkflowState(teamId, name, type, color) {
      const d = await request<Raw>(`mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success workflowState { id } } }`, { input: { teamId, name, type, color } });
      if (!d.workflowStateCreate?.success) throw new LinearApiError(`Linear refused to create status "${name}"`, false);
      return { id: d.workflowStateCreate.workflowState.id };
    },
    async createLabel(teamId, name, color) {
      const d = await request<Raw>(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }`, { input: { teamId, name, color } });
      if (!d.issueLabelCreate?.success) throw new LinearApiError(`Linear refused to create label "${name}"`, false);
      return { id: d.issueLabelCreate.issueLabel.id };
    },
    linkPullRequest: (issueId, prUrl, title) =>
      mutate(`mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkGitHubPR(issueId: $issueId, url: $url, title: $title) { success } }`, { issueId, url: prUrl, title }, "attachmentLinkGitHubPR"),
  };
}
