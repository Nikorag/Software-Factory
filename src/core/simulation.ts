import pino from "pino";
import { STAGES } from "../config/schema.js";
import type { LoadedConfig } from "../config/schema.js";
import { openDb } from "../db/client.js";
import { stageExecutions, projects } from "../db/schema.js";
import { Engine, type HandlerRegistry } from "./engine.js";
import { enqueue } from "./jobs.js";

/**
 * SIMULATION ONLY. Handlers that succeed instantly so the state machine can be exercised end to end.
 * Never wired into `serve`; real handlers arrive in later milestones.
 */
export const simulatedHandlers = (): HandlerRegistry =>
  Object.fromEntries(STAGES.filter((s) => s !== "COMPLETED").map((s) => [s, async () => ({ kind: "ok" as const, output: { simulated: true } })]));

export async function runSimulation(config: LoadedConfig, dryRun: boolean) {
  const { db, close } = openDb(":memory:");
  db.insert(projects).values({ id: "sim", configJson: "{}" }).run();
  const { job } = enqueue(db, { projectId: "sim", externalId: "sim-1", externalKey: "SIM-1", dryRun });
  const engine = new Engine({ db, logger: pino({ level: "silent" }), config, handlers: simulatedHandlers() });
  await engine.tick();
  const history = db.select().from(stageExecutions).all().map((r) => `${r.stage}:${r.outcome}`);
  close();
  return { jobId: job.id, history };
}
