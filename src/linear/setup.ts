import type { LinearConfig } from "../config/schema.js";
import type { LinearClient } from "./client.js";
import { auditTeam, type TeamAudit } from "./check.js";

type StatusKey = keyof LinearConfig["statuses"];

/** Linear workflow-state type for each status, chosen so Linear's own boards/cycles treat them sensibly. */
const STATUS_TYPE: Record<StatusKey, string> = {
  readyForSpecification: "unstarted", specificationReview: "started", readyForDevelopment: "unstarted", inProgress: "started",
  readyForReview: "started", changesRequested: "started", merging: "started", done: "completed", blocked: "started",
};
const STATUS_COLOR: Record<StatusKey, string> = {
  readyForSpecification: "#9ca3af", specificationReview: "#8b5cf6", readyForDevelopment: "#3b82f6", inProgress: "#f59e0b",
  readyForReview: "#14b8a6", changesRequested: "#f97316", merging: "#06b6d4", done: "#22c55e", blocked: "#ef4444",
};
const LABEL_COLOR: Record<string, string> = {
  enabled: "#22c55e", autonomous: "#8b5cf6", bugfix: "#ef4444", feature: "#3b82f6", maintenance: "#9ca3af", blocked: "#ef4444",
};

export type Action = { kind: "status"; key: string; name: string; type: string; color: string } | { kind: "label"; key: string; name: string; color: string };

/** What would be created. Only items that are missing; optional ones only if asked for. Never anything that exists. */
export function planSetup(a: TeamAudit, opts: { includeOptional?: boolean } = {}): Action[] {
  const want = (g: { required: boolean }) => g.required || opts.includeOptional;
  return [
    ...a.statuses.filter(want).map((g): Action => ({ kind: "status", key: g.key, name: g.name, type: STATUS_TYPE[g.key as StatusKey], color: STATUS_COLOR[g.key as StatusKey] })),
    ...a.labels.filter(want).map((g): Action => ({ kind: "label", key: g.key, name: g.name, color: LABEL_COLOR[g.key] ?? "#9ca3af" })),
  ];
}

export interface SetupResult { created: string[]; failed: { action: string; error: string }[] }

/** Creates each planned item. Re-audits first, so a re-run (or a race with a human) never duplicates. Continues past a failure. */
export async function applySetup(client: LinearClient, config: LinearConfig, team: { id: string; key: string; name: string }, opts: { includeOptional?: boolean } = {}): Promise<SetupResult> {
  const result: SetupResult = { created: [], failed: [] };
  const plan = planSetup(await auditTeam(client, config, team), opts);
  for (const act of plan) {
    try {
      if (act.kind === "status") await client.createWorkflowState(team.id, act.name, act.type, act.color);
      else await client.createLabel(team.id, act.name, act.color);
      result.created.push(`${act.kind} "${act.name}"`);
    } catch (e) {
      result.failed.push({ action: `${act.kind} "${act.name}"`, error: (e as Error).message });
    }
  }
  return result;
}
