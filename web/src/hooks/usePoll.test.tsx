import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDelay, usePoll } from "./usePoll";

/** A load function whose calls are settled by hand, so tests control the order responses arrive in. */
function manual<T>() {
  const calls: { key: unknown; signal: AbortSignal; resolve: (v: T) => void; reject: (e: Error) => void }[] = [];
  const make = (key: unknown) => (signal: AbortSignal) => new Promise<T>((resolve, reject) => { calls.push({ key, signal, resolve, reject }); });
  return { calls, make };
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("usePoll", () => {
  it("never overlaps polls: the next one starts only after the previous settles", async () => {
    const m = manual<number>();
    renderHook(() => usePoll(m.make("a"), 1000));
    expect(m.calls).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(m.calls).toHaveLength(1); // still in flight: no pile-up
    await act(async () => { m.calls[0]!.resolve(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(m.calls).toHaveLength(2);
  });
  it("drops a stale response: after the key changes, the old request is aborted and its late answer ignored", async () => {
    const m = manual<string>();
    const { result, rerender } = renderHook(({ k }) => usePoll(m.make(k), 1000, [k]), { initialProps: { k: "page1" } });
    rerender({ k: "page2" });
    expect(m.calls.map((c) => c.key)).toEqual(["page1", "page2"]);
    expect(m.calls[0]!.signal.aborted).toBe(true);
    await act(async () => { m.calls[1]!.resolve("page2 data"); });
    await act(async () => { m.calls[0]!.resolve("page1 data"); }); // lands last
    expect(result.current.data).toBe("page2 data");
  });
  it("a reload after an action wins over an older poll still in flight", async () => {
    const m = manual<string>();
    const { result } = renderHook(() => usePoll(m.make("x"), 1000));
    let done: Promise<void> = Promise.resolve();
    act(() => { done = result.current.reload(); });
    expect(m.calls).toHaveLength(2);
    await act(async () => { m.calls[1]!.resolve("after action"); await done; });
    await act(async () => { m.calls[0]!.resolve("before action"); });
    expect(result.current.data).toBe("after action");
  });
  it("keeps the last good data on error, reports it with when it was last updated, and backs off", async () => {
    const m = manual<string>();
    const { result } = renderHook(() => usePoll(m.make("x"), 1000));
    await act(async () => { m.calls[0]!.resolve("good"); });
    const at = result.current.updatedAt;
    expect(at).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { m.calls[1]!.reject(new Error("Failed to fetch")); });
    expect(result.current).toMatchObject({ data: "good", error: "Failed to fetch", updatedAt: at });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(m.calls).toHaveLength(2); // backing off: not yet
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(m.calls).toHaveLength(3);
    await act(async () => { m.calls[2]!.resolve("back"); });
    expect(result.current).toMatchObject({ data: "back", error: null });
  });
  it("does not poll while the tab is hidden, and polls at once when it is shown again", async () => {
    const m = manual<string>();
    renderHook(() => usePoll(m.make("x"), 1000));
    await act(async () => { m.calls[0]!.resolve("a"); });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(m.calls).toHaveLength(1);
    hidden.mockReturnValue(false);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(m.calls).toHaveLength(2);
    hidden.mockRestore();
  });
  it("aborts the request in flight on unmount", async () => {
    const m = manual<string>();
    const { unmount } = renderHook(() => usePoll(m.make("x"), 1000));
    unmount();
    expect(m.calls[0]!.signal.aborted).toBe(true);
    await flush();
  });
  it("backoff doubles per failure and is capped", () => {
    expect([0, 1, 2, 3, 10].map((f) => nextDelay(3000, f))).toEqual([3000, 6000, 12_000, 24_000, 60_000]);
    expect(nextDelay(30 * 60_000, 3)).toBe(30 * 60_000); // never shorter than the normal interval
  });
});
