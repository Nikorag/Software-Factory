import { COMPLETE, type Stage, type WorkflowDefinition } from "./definition.js";

/** A validated definition with the lookups the engine needs. Pure: no database, no clock. */
export class CompiledWorkflow {
  private readonly byId = new Map<string, Stage>();
  private readonly index = new Map<string, number>();

  constructor(readonly def: WorkflowDefinition) {
    def.stages.forEach((s, i) => { this.byId.set(s.id, s); this.index.set(s.id, i); });
  }

  stage(id: string): Stage | undefined { return this.byId.get(id); }
  get stages(): Stage[] { return this.def.stages; }

  /** Where a new job starts: the first enabled stage. */
  get entry(): string {
    const first = this.def.stages.find((s) => s.enabled);
    if (!first) throw new Error("the workflow has no enabled stage");
    return first.id;
  }

  /** The stage's successor before disabled stages are skipped: its explicit `next`, else the stage that follows it in the list. */
  private rawNext(id: string): string {
    const s = this.byId.get(id);
    if (s?.next) return s.next;
    const i = this.index.get(id);
    return (i === undefined ? undefined : this.def.stages[i + 1]?.id) ?? COMPLETE;
  }

  /** Where the job goes when `id` succeeds. Disabled stages are passed over. A conditional stage is decided by the engine (see `branch`). */
  next(id: string): string { return this.resolve(this.rawNext(id)); }

  /** The stage a conditional sends the job to, given whether its condition held. */
  branch(id: string, held: boolean): string {
    const c = this.byId.get(id)?.config as { then?: string; else?: string } | undefined;
    return this.resolve((held ? c?.then : c?.else) ?? COMPLETE);
  }

  /** Follows `target` forward past disabled stages (bounded: a definition that passed validation cannot loop, but never trust that here). */
  resolve(target: string): string {
    let t = target;
    for (let n = 0; n <= this.def.stages.length; n++) {
      const s = t === COMPLETE ? undefined : this.byId.get(t);
      if (t === COMPLETE || (s && s.enabled)) return t;
      if (!s) return t; // unknown id: the engine blocks the job rather than guessing
      t = this.rawNext(t);
    }
    return COMPLETE;
  }

  /** Every stage reachable in one forward step (success path and conditional branches). */
  successors(id: string): string[] {
    const s = this.byId.get(id);
    if (!s) return [];
    if (s.type === "conditional") {
      const c = s.config as { then?: string; else?: string };
      return [c.then, c.else].filter((x): x is string => Boolean(x)).map((t) => this.resolve(t));
    }
    return [this.next(id)];
  }

  /** Stages a failure route can send `id` to. */
  routeTargets(id: string): string[] {
    return (this.byId.get(id)?.onFailure ?? []).flatMap((r) => (r.action === "goto" && r.target ? [r.target] : []));
  }

  /** Every stage id (enabled or not) that can run before `id` on some path, following success and failure routes. */
  reachableFrom(start: string, without?: string): Set<string> {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === COMPLETE || id === without || seen.has(id) || !this.byId.has(id)) continue;
      seen.add(id);
      stack.push(...this.successors(id), ...this.routeTargets(id).map((t) => this.resolve(t)));
    }
    return seen;
  }
}
