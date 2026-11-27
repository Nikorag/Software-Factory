import { describe, expect, it } from "vitest";
import { exhaustedLimit, type ClaudeLimits, type LimitWindow } from "../src/agents/usage.js";

const NOW = 1_000_000;
const w = (over: Partial<LimitWindow> = {}): LimitWindow => ({ utilization: 0.5, resetsAt: NOW + 3_600_000, status: "allowed", ...over });
const limits = (fiveHour: LimitWindow | null, sevenDay: LimitWindow | null = null): ClaudeLimits => ({ fiveHour, sevenDay, status: null, capturedAt: NOW });

describe("exhaustedLimit", () => {
  it("is null with no reading or a healthy one", () => {
    expect(exhaustedLimit(null, NOW)).toBeNull();
    expect(exhaustedLimit(limits(w(), w({ utilization: 0.99, status: "allowed_warning" })), NOW)).toBeNull();
  });
  it("blocks on a full five-hour window, reporting its reset", () => {
    expect(exhaustedLimit(limits(w({ utilization: 1 })), NOW)).toEqual({ window: "fiveHour", resetsAt: NOW + 3_600_000 });
  });
  it("blocks on a full seven-day window", () => {
    expect(exhaustedLimit(limits(w(), w({ utilization: 1.02, resetsAt: NOW + 9_000_000 })), NOW)).toEqual({ window: "sevenDay", resetsAt: NOW + 9_000_000 });
  });
  it("blocks on a rejected status alone", () => {
    expect(exhaustedLimit(limits(w({ status: "rejected" })), NOW)?.window).toBe("fiveHour");
    expect(exhaustedLimit(limits(null, w({ status: "rejected" })), NOW)?.window).toBe("sevenDay");
  });
  it("when both block, the later reset is reported", () => {
    expect(exhaustedLimit(limits(w({ utilization: 1 }), w({ utilization: 1, resetsAt: NOW + 9_000_000 })), NOW)).toEqual({ window: "sevenDay", resetsAt: NOW + 9_000_000 });
  });
  it("does not block once the reset has passed (stale reading)", () => {
    expect(exhaustedLimit(limits(w({ utilization: 1, resetsAt: NOW - 1 })), NOW)).toBeNull();
    expect(exhaustedLimit(limits(w({ utilization: 1, resetsAt: NOW })), NOW)).toBeNull();
  });
  it("does not block when the reset is unknown: nothing would ever clear it", () => {
    expect(exhaustedLimit(limits(w({ utilization: 1, resetsAt: null })), NOW)).toBeNull();
    expect(exhaustedLimit(limits(w({ status: "rejected", resetsAt: null })), NOW)).toBeNull();
  });
});
