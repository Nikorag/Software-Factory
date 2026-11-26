import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { stripOrder } from "@/lib/pipeline";
import type { WorkflowFull } from "@/lib/workflows";

/** One fetch per workflow for a whole list of jobs: the stage order (and names) their progress strips are drawn from. */
const cache = new Map<string, { at: number; p: Promise<{ order: string[]; names: Record<string, string> } | null> }>();
const TTL = 60_000;
export function loadStrip(id: string) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = api<WorkflowFull>(`/api/workflows/${encodeURIComponent(id)}`).then((w) => ({ order: stripOrder(w.definition), names: Object.fromEntries(w.definition.stages.map((s) => [s.id, s.name])) })).catch(() => null);
  cache.set(id, { at: Date.now(), p });
  return p;
}
export function useStripOrder(workflowId: string | null | undefined) {
  const id = workflowId ?? "default";
  const [v, setV] = useState<{ order: string[]; names: Record<string, string> } | null>(null);
  useEffect(() => { let live = true; void loadStrip(id).then((r) => { if (live) setV(r); }); return () => { live = false; }; }, [id]);
  return v;
}
