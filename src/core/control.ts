import { eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, factoryState } from "../db/schema.js";

export interface ControlState { paused: boolean; emergencyStop: boolean; reason: string | null }

export function getControl(db: FactoryDb): ControlState {
  const r = db.select().from(factoryState).where(eq(factoryState.id, 1)).get();
  return { paused: r?.paused ?? false, emergencyStop: r?.emergencyStop ?? false, reason: r?.reason ?? null };
}

function set(db: FactoryDb, patch: Partial<{ paused: boolean; emergencyStop: boolean }>, reason: string | null, actor: string, kind: string) {
  db.transaction((tx) => {
    tx.update(factoryState).set({ ...patch, reason, updatedAt: new Date() }).where(eq(factoryState.id, 1)).run();
    tx.insert(decisions).values({ kind, decision: JSON.stringify(patch), rationale: reason, actor }).run();
  });
}

/** Stops new jobs from starting. Running jobs finish their current stage, then hold. */
export const pause = (db: FactoryDb, actor: string, reason?: string) => set(db, { paused: true }, reason ?? null, actor, "control.pause");
export const resume = (db: FactoryDb, actor: string) => set(db, { paused: false }, null, actor, "control.resume");
/** Stops new jobs AND signals running agents to terminate. Jobs hold in PAUSED and can resume after clearing. */
export const emergencyStop = (db: FactoryDb, actor: string, reason?: string) => set(db, { emergencyStop: true, paused: true }, reason ?? null, actor, "control.emergency_stop");
/** Clearing the stop does not resume; the factory stays paused until explicitly resumed. */
export const clearEmergencyStop = (db: FactoryDb, actor: string) => set(db, { emergencyStop: false }, null, actor, "control.clear_emergency_stop");
