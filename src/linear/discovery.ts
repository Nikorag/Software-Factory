import { and, desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { pickupModeOf, type LinearConfig, type PlanningMode, type ProjectConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs } from "../db/schema.js";
import { enqueue } from "../core/jobs.js";
import { isRunnable, onboardingFor } from "../repo/registry.js";
import type { LinearClient, LinearIssue } from "./client.js";
import { enqueueOutbox } from "./outbox.js";
import { evaluateEligibility } from "./eligibility.js";
import type { TrackerSet } from "../tracker/index.js";

export interface DiscoveryReport {
  enqueued: { key: string; jobId: string; projectId: string; workflow: string; autonomous: boolean }[];
  skipped: { key: string; projectId?: string; reasons: string[] }[];
  errors: { projectId: string; error: string }[];
}

const specificity = (p: ProjectConfig) => (p.linear?.projectId || p.linear?.projectName ? 2 : 1);

/**
 * One polling pass. Reads Linear, decides eligibility, creates idempotent jobs. Never changes issue state
 * itself (status writes go through the outbox once a job starts). Safe to run repeatedly and concurrently.
 */
export async function discoverIssues(deps: {
  db: FactoryDb; client?: LinearClient; linear: LinearConfig; projects: ProjectConfig[]; logger: Logger; dryRun?: boolean;
  /** When projects live in different tracker connections: which client and names each one uses. Without it, `client` and `linear` serve every project. */
  trackers?: TrackerSet;
  /** The profile's default pickup mode: projects in manual mode are never polled. */
  pickupMode?: "automatic" | "manual";
  /** Skip tickets of projects whose onboarding is not complete (the service turns this on). */
  requireOnboarding?: boolean;
  /** The profile's planning mode: Spec Kit only counts as an onboarding step in `speckit` mode. */
  planningMode?: PlanningMode;
}): Promise<DiscoveryReport> {
  const { db, client, linear, logger } = deps;
  const report: DiscoveryReport = { enqueued: [], skipped: [], errors: [] };
  const bound = deps.projects.filter((p) => p.enabled && p.linear && pickupModeOf(p, { pickupMode: deps.pickupMode ?? "automatic" }) === "automatic"); // manual projects are started from the Board

  // Collect candidates per project; an issue may match several project bindings.
  const matches = new Map<string, { issue: LinearIssue; projects: ProjectConfig[]; names: LinearConfig }>();
  for (const p of bound) {
    try {
      const tid = deps.trackers?.idOf(p) ?? "";
      const names = deps.trackers ? deps.trackers.names(tid) : linear;
      if (!names.statuses.readyForSpecification || !names.labels.enabled) {
        // Jira: nothing is guessed. Until the pickup status and the opt-in label are mapped there is nothing to search for.
        report.errors.push({ projectId: p.id, error: "the tracker mapping is incomplete: map the \"Ready for specification\" status and the \"enabled\" label in Settings → Trackers (or use manual mode)" });
        continue;
      }
      const issues = await (deps.trackers ? deps.trackers.client(tid) : client!).listIssues({
        teamKey: p.linear!.teamKey, projectId: p.linear!.projectId, projectName: p.linear!.projectName,
        stateName: names.statuses.readyForSpecification, labelName: names.labels.enabled,
      });
      for (const issue of issues) {
        const k = `${tid}|${issue.id}`; // the same id in two connections is two different tickets
        const m = matches.get(k) ?? { issue, projects: [], names };
        m.projects.push(p);
        matches.set(k, m);
      }
    } catch (e) {
      report.errors.push({ projectId: p.id, error: (e as Error).message });
      logger.error({ projectId: p.id, err: (e as Error).message }, "linear discovery failed for project");
    }
  }

  for (const { issue, projects, names } of matches.values()) {
    // Most specific binding wins (team+project beats team-only); a tie is ambiguous and is not guessed at.
    const top = Math.max(...projects.map(specificity));
    const best = projects.filter((p) => specificity(p) === top);
    if (best.length > 1) {
      report.skipped.push({ key: issue.identifier, reasons: [`ambiguous project mapping: ${best.map((p) => p.id).join(", ")}`] });
      continue;
    }
    const project = best[0]!;
    const prior = db.select().from(jobs).where(and(eq(jobs.projectId, project.id), eq(jobs.externalId, issue.id))).orderBy(desc(jobs.createdAt)).limit(1).get();
    const verdict = evaluateEligibility(issue, project, names, { projectRunnable: isRunnable(db, project.id), existingJobStatus: prior?.status });
    if (verdict.eligible && deps.requireOnboarding) {
      const ob = onboardingFor(db, project, deps.planningMode);
      if (ob.status !== "ready") {
        const todo = ob.steps.filter((x) => !x.ok).map((x) => x.label.toLowerCase());
        if (!prior) report.skipped.push({ key: issue.identifier, projectId: project.id, reasons: [`project ${project.id} is not onboarded yet (still to do: ${todo.join("; ")}): finish it in Settings > Projects`] });
        continue;
      }
    }
    if (!verdict.eligible) {
      // An issue already being processed is expected on every poll; only report genuinely new rejections.
      if (!prior || prior.status === "cancelled") report.skipped.push({ key: issue.identifier, projectId: project.id, reasons: verdict.reasons });
      continue;
    }
    const { job, created } = enqueue(db, {
      projectId: project.id, externalId: issue.id, externalKey: issue.identifier, title: issue.title,
      workflow: verdict.workflow, autonomous: verdict.autonomous, dryRun: deps.dryRun ?? false,
    });
    if (!created) continue;
    db.insert(decisions).values({
      jobId: job.id, kind: "discovery.accept", actor: "factory",
      decision: `accepted ${issue.identifier} as ${verdict.workflow}${verdict.autonomous ? " (autonomous)" : ""}`,
      rationale: `${issue.url} -> project ${project.id}`,
    }).run();
    if (!deps.dryRun) {
      enqueueOutbox(db, job.id, issue.id, { kind: "comment", body: `**Software factory** picked this up as a \`${verdict.workflow}\` job${verdict.autonomous ? " (autonomous)" : ""}.` }, `${job.id}:pickup`);
    }
    report.enqueued.push({ key: issue.identifier, jobId: job.id, projectId: project.id, workflow: verdict.workflow, autonomous: verdict.autonomous });
  }
  return report;
}
