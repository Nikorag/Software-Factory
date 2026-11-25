import { ConfigError } from "../config/load.js";
import type { LinearConfig, ProjectConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions } from "../db/schema.js";
import type { HandlerRegistry } from "../core/engine.js";
import { isRunnable } from "../repo/registry.js";
import { LinearApiError, type LinearClient } from "./client.js";
import { evaluateEligibility } from "./eligibility.js";

/**
 * DISCOVERED and ELIGIBILITY_CHECK. Discovery may have happened hours before the job runs, so eligibility is
 * re-checked against the live ticket when work actually starts: if a human removed `factory:enabled`, added
 * `factory:blocked` or moved the ticket, the factory stops rather than act on stale intent.
 */
export function createIntakeHandlers(d: { db: FactoryDb; linear: () => LinearClient; linearConfig: LinearConfig; project: (id: string) => ProjectConfig }): HandlerRegistry {
  return {
    // Nothing to do: the job exists because discovery accepted the issue (and recorded why).
    DISCOVERED: async () => ({ kind: "ok" }),

    ELIGIBILITY_CHECK: async ({ job }) => {
      let issue;
      try {
        issue = await d.linear().getIssue(job.externalId);
      } catch (e) {
        if (e instanceof ConfigError) return { kind: "blocked", reason: e.message };
        if (e instanceof LinearApiError && !e.retryable) return { kind: "blocked", reason: `cannot read the Linear issue: ${e.message}` };
        throw e; // transient: the engine retries
      }
      const project = d.project(job.projectId);
      // Prior jobs are ignored here: this job *is* the one allowed to process the issue.
      const v = evaluateEligibility(issue, project, d.linearConfig, { projectRunnable: isRunnable(d.db, project.id) });
      d.db.insert(decisions).values({ jobId: job.id, kind: "eligibility", decision: v.eligible ? "eligible" : "no longer eligible", rationale: v.reasons.join("; ") || null, actor: "factory" }).run();
      if (!v.eligible) {
        return { kind: "blocked", reason: `This ticket is no longer eligible for the factory: ${v.reasons.join("; ")}. Fix that in Linear, then retry the job.` };
      }
      return { kind: "ok", output: { workflow: v.workflow, autonomous: v.autonomous, state: issue.state.name } };
    },
  };
}
