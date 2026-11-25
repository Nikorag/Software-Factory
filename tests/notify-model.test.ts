import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type J = { id: string; key: string; stage: string; status: string; lastError?: string | null };
const { newInterruptions } = createRequire(import.meta.url)("../desktop/notify-model.cjs") as { newInterruptions: (p: string, j: J[], seen: Set<string>, seeded: boolean) => { title: string; body: string; jobId: string }[] };

const blocked: J = { id: "a", key: "JAM-1", stage: "BLOCKED", status: "waiting", lastError: "Which port?\nmore" };
const failed: J = { id: "b", key: "JAM-2", stage: "FAILED", status: "failed", lastError: "tests failed" };
const running: J = { id: "c", key: "JAM-3", stage: "IMPLEMENTATION", status: "running" };
const waitingOnCi: J = { id: "d", key: "JAM-4", stage: "CI_WATCH", status: "waiting" };

describe("interruption notifications", () => {
  it("does not notify on the first poll (old news), only seeds", () => {
    const seen = new Set<string>();
    expect(newInterruptions("home", [blocked, failed], seen, false)).toEqual([]);
    expect(newInterruptions("home", [blocked, failed], seen, true)).toEqual([]); // already known
  });
  it("notifies once for a job that needs a person or failed, and ignores jobs that are merely running or waiting on CI", () => {
    const seen = new Set<string>();
    newInterruptions("home", [], seen, false);
    const out = newInterruptions("home", [blocked, failed, running, waitingOnCi], seen, true);
    expect(out.map((n) => n.title)).toEqual(["JAM-1 needs your answer", "JAM-2 failed"]);
    expect(out[0]!.body).toBe("Which port?");
    expect(newInterruptions("home", [blocked, failed], seen, true)).toEqual([]);
  });
  it("notifies again when a job is retried and stops again", () => {
    const seen = new Set<string>();
    newInterruptions("home", [], seen, false);
    newInterruptions("home", [failed], seen, true);
    newInterruptions("home", [], seen, true); // retried: no longer stopped
    expect(newInterruptions("home", [failed], seen, true)).toHaveLength(1);
  });
  it("keeps profiles apart", () => {
    const seen = new Set<string>();
    newInterruptions("home", [], seen, false);
    newInterruptions("work", [], seen, false);
    expect(newInterruptions("home", [blocked], seen, true)).toHaveLength(1);
    expect(newInterruptions("work", [blocked], seen, true)).toHaveLength(1);
  });
});
