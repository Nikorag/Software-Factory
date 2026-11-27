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
  it("notifies when a job waits at a human gate", () => {
    const seen = new Set<string>();
    newInterruptions("home", [], seen, false);
    const gated: J = { id: "g", key: "JAM-5", stage: "AWAITING_CONFIRMATION", status: "waiting", lastError: "Waiting for your confirmation: the generated prompt gate." };
    expect(newInterruptions("home", [gated], seen, true).map((n) => n.title)).toEqual(["JAM-5 needs your confirmation"]);
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

type S = { name: string; up: boolean; stoppedOnPurpose: boolean };
const { unexpectedStops } = createRequire(import.meta.url)("../desktop/notify-model.cjs") as { unexpectedStops: (s: S[], wasUp: Map<string, boolean>) => { profile: string; title: string; body: string }[] };

describe("unexpected-stop notifications (a `start`ed factory has no supervisor)", () => {
  it("notifies when a factory that was up goes down without having been asked to stop", () => {
    const was = new Map<string, boolean>();
    expect(unexpectedStops([{ name: "home", up: true, stoppedOnPurpose: false }, { name: "work", up: true, stoppedOnPurpose: false }], was)).toEqual([]);
    const out = unexpectedStops([{ name: "home", up: false, stoppedOnPurpose: false }, { name: "work", up: true, stoppedOnPurpose: false }], was);
    expect(out.map((n) => n.profile)).toEqual(["home"]); expect(out[0]!.title).toContain("stopped unexpectedly");
    expect(unexpectedStops([{ name: "home", up: false, stoppedOnPurpose: false }], was)).toEqual([]); // once, not every poll
  });
  it("is quiet for a requested stop, for a factory first seen stopped, and for one coming back up", () => {
    const was = new Map<string, boolean>();
    expect(unexpectedStops([{ name: "home", up: false, stoppedOnPurpose: false }], was)).toEqual([]); // never seen up
    unexpectedStops([{ name: "home", up: true, stoppedOnPurpose: false }], was);
    expect(unexpectedStops([{ name: "home", up: false, stoppedOnPurpose: true }], was)).toEqual([]); // `shutdown` / Stop the Factory
    expect(unexpectedStops([{ name: "home", up: true, stoppedOnPurpose: false }], was)).toEqual([]);
  });
});
