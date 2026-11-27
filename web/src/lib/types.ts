export interface Job {
  /** The ticket title (absent for jobs from before it was recorded). */
  title?: string | null;
  /** How the job is planned; absent (an older server) means Spec Kit, the original flow. */
  planningMode?: "haiku_prompt" | "speckit";
  id: string; key: string; project: string; workflow: string; stage: string; status: string; heldFromStage: string | null;
  remediationAttempts: number; stageAttempts: number; autonomous: boolean; dryRun: boolean; prUrl: string | null;
  lastError: string | null; notBefore: number | null; createdAt: number | null; updatedAt: number | null; archivedAt?: number | null;
}
export interface Health { name: string; status: string; detail: string; checkedAt: number }
export interface SystemInfo {
  memory: { availableBytes: number; totalBytes: number; freePercent: number | null; pressure: string };
  disk: { freeBytes: number; totalBytes: number } | null; load: number[];
}
export interface Scheduler {
  lastDiscovery: { ok: boolean; at: number; enqueued: number; skipped?: number; error?: string } | null;
  lastFlush: { sent: number; pending: number; failed: number; at: number } | null;
}
export interface Overview {
  control: { paused: boolean; emergencyStop: boolean; reason?: string | null };
  counts: { byStatus: Record<string, number>; outbox: { pending: number; failed: number }; recentAgentFailures: { rateLimited: number } };
  active: Job[]; queued: Job[]; recent: Job[]; scheduler: Scheduler | null; system: SystemInfo; health: Health[]; mergeMode: string; dryRun: boolean; projectCount?: number;
  claudeUsage?: ClaudeUsage;
}
export interface LimitWindow { utilization: number; resetsAt: number | null; status: string | null }
export interface ClaudeUsage { limits: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; status: string | null; capturedAt: number } | null; estimatedListCostUsd: { last24h: number; last7d: number } }
export interface Execution { id: number; stage: string; attempt: number; outcome: string; error: string | null; output: string | null; startedAt: number | null; finishedAt: number | null }
export interface Decision { id: number; kind: string; decision: string; rationale: string | null; actor: string; at: number | null }
export interface Invocation { id: number; stageExecutionId: number | null; agent: string; model: string | null; exitCode: number | null; durationMs: number | null; /** the run is over (exit code, signal, local-model failure or service restart): never "live" */ finished: boolean; usage: { denials?: number } | null; hasLog: boolean; at: number | null }
export interface JobDetail {
  job: Job; remediationCap?: number; stageOrder: string[]; executions: Execution[]; decisions: Decision[]; invocations: Invocation[];
  artifacts: { kind: string; path: string; bytes: number | null; at: number | null }[];
  /** The Haiku-written implementer prompt and its acceptance criteria (haiku_prompt mode). */
  plan?: { prompt: string; criteria: { id: string; text: string }[] } | null;
  worktree: { path: string; state: string; branch: string } | null;
  outbox: { id: number; kind: string; status: string; attempts: number; lastError: string | null }[];
  /** Change requests on the job's pull request, oldest first (absent from servers that predate them). */
  feedback?: Feedback[];
}
export interface Feedback {
  id: number; source: "dashboard" | "github"; author: string; body: string; path: string | null; line: number | null; url: string | null;
  status: "pending" | "applying" | "done" | "ignored"; note: string | null; at: number | null; updatedAt: number | null;
}
export interface Project {
  host?: "github" | "bitbucket"; bitbucketRepo?: string | null; bitbucketCredential?: string;
  id: string; name: string; enabled: boolean; autonomy: string; repository: string; githubRepo: string | null; defaultBranch: string; githubAccount: string | null; managed: boolean; specKit?: boolean; allowLoopback?: boolean; agentBashAllow?: string[]; overrides: { maxImplementationPasses?: number; pickupMode?: "automatic" | "manual"; maxConcurrentJobs?: number; maxRemediationAttempts?: number; agentAccess?: "restricted" | "unrestricted"; models?: Partial<import("./tasks").Routes> } | null;
  tracker?: string | null; linear: { teamKey: string; projectName?: string; projectId?: string } | null; commands: Record<string, string | undefined>;
  validation: { ok: boolean; protection: string; findings: string[] } | null; activeJobs: number;
  onboarding?: { status: "ready" | "in-progress" | "not-started"; steps: { id: string; label: string; ok: boolean; detail: string }[] };
}
export interface HealthReport { system: SystemInfo; health: Health[]; scheduler: Scheduler | null }

export interface SetupInfo { configDir: string | null; homeConfigDir: string; usingDefaults: boolean; projectCount: number; tracker: { kind: "linear" | "jira" | "github"; id?: string; name: string; connected: boolean }; linear: { keyPresent: boolean; env: string; keychainService: string | null } }
export interface TeamAudit { key: string; name: string; projects: string[]; audited?: boolean; audit: { ok: boolean; statuses: { name: string; required: boolean }[]; labels: { name: string; required: boolean }[] } }
export interface TaskState { id: string; label: string; status: "running" | "ok" | "failed"; lines: string[] }
export interface UpdateInfo { version?: string; error?: string; current: string | null; latest: string | null; available: boolean; checkedAt: number | null }
export interface ProfileInfo { name: string; port: number; url: string; current: boolean; running: boolean }
export interface GhAccounts { accounts: { login: string; active: boolean }[]; defaultAccount: string | null }
export interface BoardItem {
  id: string; key: string; title: string; url: string; state: string; stateType: string; labels: string[]; linearProject: string | null;
  projectId: string; projectName: string; mode: "automatic" | "manual"; job: { id: string; status: string; stage: string } | null; canStart: boolean; reason: string | null;
}
export interface Board { mode: "automatic" | "manual"; query: string; items: BoardItem[]; projects: { id: string; name: string; mode: "automatic" | "manual" }[] }
export interface GithubIssuesMapping { statusPrefix: string; statuses: Record<string, string>; labels: Record<string, string>; account?: string | null }
/** One tracker connection (an instance of Linear, Jira or GitHub Issues); a profile can have several of each. */
export interface TrackerEntry { id: string; kind: "linear" | "jira" | "github"; label: string; builtin: boolean; isDefault: boolean; connected: boolean; projects: string[]; env?: string; keychainService?: string }
export interface JiraStatus { tracker: "linear" | "jira" | "github"; clientId: string | null; secretSet: boolean; connected: boolean; site: { cloudId: string; url: string; name: string } | null; siteChoices: { id: string; name: string; url: string }[]; callbackUrl: string; scopes: string[] }
export interface JiraMetadata { projects: { key: string; name: string }[]; project: string | null; statuses: string[]; labels: string[] }
export interface JiraMapping { statuses: Record<string, string>; labels: Record<string, string>; required: { statuses: string[]; labels: string[]; automaticStatus: string; automaticLabel: string } }
export interface JiraCheck { ok: boolean; projects: { projectId: string; jiraProject: string; found: boolean; missing: string[] }[] }
export interface BitbucketCredential { name: string; kind: "access-token" | "api-token"; email: string | null; hasToken: boolean; usedBy: string[] }
