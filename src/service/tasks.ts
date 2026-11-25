import { randomUUID } from "node:crypto";

export interface Task { id: string; label: string; scope: string; status: "running" | "ok" | "failed"; lines: string[]; startedAt: number; finishedAt: number | null }
const MAX_LINES = 500, MAX_TASKS = 40;

/** Long actions (clone, validate, run a project's checks, open an onboarding PR) run in the background; the UI polls the task. In memory only: a restart forgets them, and none of them is needed for correctness. */
export class TaskManager {
  private tasks = new Map<string, Task>();

  /** One task at a time per scope (e.g. a project): a second request while one runs is refused, not queued. */
  start(label: string, scope: string, fn: (log: (line: string) => void) => Promise<boolean>): Task {
    for (const t of this.tasks.values()) if (t.scope === scope && t.status === "running") throw new Error(`"${t.label}" is already running for ${scope}`);
    const task: Task = { id: randomUUID(), label, scope, status: "running", lines: [], startedAt: Date.now(), finishedAt: null };
    this.tasks.set(task.id, task);
    for (const id of [...this.tasks.keys()].slice(0, Math.max(0, this.tasks.size - MAX_TASKS))) this.tasks.delete(id);
    const log = (line: string) => { for (const l of line.split("\n")) if (task.lines.push(l.slice(0, 600)) > MAX_LINES) task.lines.shift(); };
    fn(log).then((ok) => { task.status = ok ? "ok" : "failed"; }, (e: unknown) => { log(`error: ${(e as Error).message}`); task.status = "failed"; }).finally(() => { task.finishedAt = Date.now(); });
    return task;
  }
  get(id: string): Task | undefined { return this.tasks.get(id); }
}
