import { and, count, desc, eq } from "drizzle-orm";
import type { StageName, LinearConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, linearOutbox } from "../db/schema.js";
import type { EngineObserver } from "../core/engine.js";
import type { JobRow } from "../core/jobs.js";
import { enqueueOutbox, type OutboxOp } from "./outbox.js";

type StateKey = keyof LinearConfig["statuses"];

/** Which Linear status reflects each stage. Stages not listed leave the status alone. */
export function statusForStage(stage: StageName): StateKey | undefined {
  switch (stage) {
    case "REQUIREMENTS_ANALYSIS": case "SPECIFICATION_GENERATION": case "SPECIFICATION_REVIEW":
    case "SPECIFICATION_REMEDIATION": case "SPECIFICATION_VALIDATION":
      return "specificationReview";
    case "IMPLEMENTATION_PREPARATION": case "IMPLEMENTATION": case "AUTOMATED_TESTING": case "LOCAL_MODEL_REVIEW":
    case "CLAUDE_REVIEW": case "REMEDIATION": case "FINAL_VALIDATION":
      return "inProgress";
    case "PULL_REQUEST_CREATION": case "CI_VALIDATION": case "MERGE_VALIDATION":
      return "readyForReview";
    case "MERGING": case "LINEAR_COMPLETION": return "merging";
    case "COMPLETED": return "done";
    case "BLOCKED": case "NEEDS_ATTENTION": case "FAILED": return "blocked";
    default: return undefined; // DISCOVERED, ELIGIBILITY_CHECK, PAUSED, CANCELLED
  }
}

const HELD_HUMAN = new Set<StageName>(["BLOCKED", "NEEDS_ATTENTION", "FAILED"]);
const TITLES: Partial<Record<StageName, string>> = {
  BLOCKED: "Blocked", NEEDS_ATTENTION: "Needs attention", FAILED: "Failed", CANCELLED: "Cancelled", COMPLETED: "Completed",
};

/**
 * Translates stage changes into outbox rows. Runs inside the engine's transaction, so a stage change and its
 * Linear update are committed together. Dry-run jobs record the intention instead of queuing a write.
 */
export function createLinearReporter(db: FactoryDb, opts: { globalDryRun?: () => boolean } = {}): EngineObserver {
  return {
    onStage(job: JobRow, stage: StageName, detail) {
      const issueId = job.externalId;
      const dry = job.dryRun || (opts.globalDryRun?.() ?? false);
      const ops: { op: OutboxOp; key: string }[] = [];
      const seq = (kind: string) => db.select({ n: count() }).from(linearOutbox).where(and(eq(linearOutbox.jobId, job.id), eq(linearOutbox.kind, kind as never))).get()?.n ?? 0;
      const last = (kind: string) => db.select().from(linearOutbox).where(and(eq(linearOutbox.jobId, job.id), eq(linearOutbox.kind, kind as never))).orderBy(desc(linearOutbox.id)).limit(1).get();

      const target = statusForStage(stage);
      if (target) {
        const prev = last("set_state");
        if (!prev || (JSON.parse(prev.payloadJson) as { stateKey: string }).stateKey !== target) {
          ops.push({ op: { kind: "set_state", stateKey: target }, key: `${job.id}:state:${target}:${seq("set_state")}` });
        }
      }
      const labelOps = db.select().from(linearOutbox).where(and(eq(linearOutbox.jobId, job.id), eq(linearOutbox.kind, "add_label"))).all().length
        - db.select().from(linearOutbox).where(and(eq(linearOutbox.jobId, job.id), eq(linearOutbox.kind, "remove_label"))).all().length;
      const blockedLabelOn = labelOps > 0;
      if (HELD_HUMAN.has(stage) && !blockedLabelOn) {
        ops.push({ op: { kind: "add_label", labelKey: "blocked" }, key: `${job.id}:label+blocked:${seq("add_label")}` });
      } else if (!HELD_HUMAN.has(stage) && blockedLabelOn) {
        ops.push({ op: { kind: "remove_label", labelKey: "blocked" }, key: `${job.id}:label-blocked:${seq("remove_label")}` });
      }
      const title = TITLES[stage];
      if (title && stage !== "COMPLETED") {
        const body = `**Software factory: ${title}** (stage \`${job.heldFromStage ?? stage}\`)${detail?.reason ? `\n\n${detail.reason}` : ""}`;
        ops.push({ op: { kind: "comment", body }, key: `${job.id}:comment:${stage}:${seq("comment")}` });
      }

      for (const { op, key } of ops) {
        if (dry) {
          db.insert(decisions).values({ jobId: job.id, kind: "dry-run", decision: `would send to Linear: ${JSON.stringify(op)}`, actor: "factory" }).run();
        } else {
          enqueueOutbox(db, job.id, issueId, op, key);
        }
      }
    },
  };
}
