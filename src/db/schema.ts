import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  configJson: text("config_json").notNull(), // snapshot of validated ProjectConfig
  lastValidatedAt: ts("last_validated_at"),
  validationJson: text("validation_json"),
  // Result of the last "run this project's commands" check (sandboxed, in a throwaway worktree): { ok, at, ran: [...] }
  checkJson: text("check_json"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    externalId: text("external_id").notNull(), // Linear issue id
    externalKey: text("external_key").notNull(), // e.g. ENG-123
    title: text("title"), // the ticket's title, recorded at pickup and refreshed whenever a stage reads the ticket (null for jobs from before it was kept)
    workflow: text("workflow").notNull().default("feature"),
    stage: text("stage").notNull().default("DISCOVERED"),
    status: text("status", { enum: ["queued", "running", "waiting", "done", "failed", "cancelled"] }).notNull().default("queued"),
    remediationAttempts: integer("remediation_attempts").notNull().default(0),
    stageAttempts: integer("stage_attempts").notNull().default(0),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    heldFromStage: text("held_from_stage"), // stage to resume at when a held/failed job is retried
    notBefore: ts("not_before"), // retry backoff: not claimable before this time
    leaseOwner: text("lease_owner"), // process that holds the job
    leaseExpiresAt: ts("lease_expires_at"),
    autonomous: integer("autonomous", { mode: "boolean" }).notNull().default(false), // issue label AND project autonomy at pickup
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    manual: integer("manual", { mode: "boolean" }).notNull().default(false), // a person picked this ticket on the Board (no label or status required)
    prUrl: text("pr_url"),
    lastError: text("last_error"),
    archivedAt: ts("archived_at"), // hidden from lists by default; only finished jobs can be archived
    createdAt: ts("created_at").notNull().default(now),
    updatedAt: ts("updated_at").notNull().default(now),
  },
  (t) => [
    // Core guarantee: an issue can only have one active job at a time.
    uniqueIndex("jobs_one_active_per_issue")
      .on(t.projectId, t.externalId)
      .where(sql`status in ('queued','running','waiting')`),
    index("jobs_status_idx").on(t.status),
  ],
);

// Append-only history of every stage entry/exit. `idempotencyKey` stops a replayed step re-recording.
export const stageExecutions = sqliteTable(
  "stage_executions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull().references(() => jobs.id),
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome", { enum: ["started", "succeeded", "failed", "timed_out", "cancelled", "waiting"] }).notNull(),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: ts("started_at").notNull().default(now),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("stage_exec_idem").on(t.idempotencyKey)],
);

export const agentInvocations = sqliteTable("agent_invocations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.id),
  stageExecutionId: integer("stage_execution_id").references(() => stageExecutions.id),
  agent: text("agent").notNull(), // e.g. claude-code, local-qwen
  model: text("model"),
  cwd: text("cwd"),
  exitCode: integer("exit_code"),
  durationMs: integer("duration_ms"),
  usageJson: text("usage_json"),
  logPath: text("log_path"), // stdout/stderr live on disk, not in the DB
  startedAt: ts("started_at").notNull().default(now),
});

export const worktrees = sqliteTable("worktrees", {
  jobId: text("job_id").primaryKey().references(() => jobs.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  path: text("path").notNull().unique(),
  branch: text("branch").notNull(),
  // The commit the branch was created from. Every diff, boundary check and review is measured against THIS, never against a
  // moving ref such as the local default branch (which can be stale: that once flagged the whole of main as "agent changes").
  baseSha: text("base_sha"),
  state: text("state", { enum: ["active", "preserved", "removed"] }).notNull().default("active"),
  createdAt: ts("created_at").notNull().default(now),
});

// Every autonomous decision, with who/what made it and why.
export const decisions = sqliteTable("decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").references(() => jobs.id),
  kind: text("kind").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale"),
  actor: text("actor").notNull(),
  createdAt: ts("created_at").notNull().default(now),
});

// Singleton control row: global pause and emergency stop survive restarts.
export const factoryState = sqliteTable("factory_state", {
  id: integer("id").primaryKey(),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  emergencyStop: integer("emergency_stop", { mode: "boolean" }).notNull().default(false),
  reason: text("reason"),
  updatedAt: ts("updated_at").notNull().default(now),
});

// Durable queue of writes to Linear. Rows are inserted in the same transaction as the stage change that caused them.
export const linearOutbox = sqliteTable(
  "linear_outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull().references(() => jobs.id),
    issueId: text("issue_id").notNull(),
    kind: text("kind", { enum: ["set_state", "add_label", "remove_label", "comment", "link_pr"] }).notNull(),
    payloadJson: text("payload_json").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: ["pending", "done", "failed"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: ts("next_attempt_at"),
    createdAt: ts("created_at").notNull().default(now),
    doneAt: ts("done_at"),
  },
  (t) => [uniqueIndex("linear_outbox_idem").on(t.idempotencyKey), index("linear_outbox_status_idx").on(t.status)],
);

// References to files a job produced (specs, plans, task lists, analyses). Content lives in git; this records what
// existed when, with a hash, so evidence can be cited later and replays can skip completed steps.
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull().references(() => jobs.id),
    kind: text("kind").notNull(), // spec | plan | tasks | checklist | research | data-model | contract | ticket | step:<name> | ...
    path: text("path").notNull(), // relative to the job worktree
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: ts("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("artifacts_job_path_sha").on(t.jobId, t.path, t.sha256), index("artifacts_job_idx").on(t.jobId)],
);
