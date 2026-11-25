import { useCallback, useEffect, useRef, useState } from "react";

/** How long to wait before the next poll: the normal interval, doubled per consecutive failure, capped (but never below the interval). */
export function nextDelay(ms: number, failures: number, maxMs = Math.max(ms, 60_000)): number {
  return failures <= 0 ? ms : Math.min(ms * 2 ** failures, maxMs);
}

/**
 * Loads on mount, then again `ms` after each request settles (a setTimeout chain, so polls never overlap), while the tab is visible.
 * - Each request gets an AbortSignal and a sequence number: a newer request (a reload, or a change of `deps`) aborts the older one, and
 *   any response that is not from the newest request is dropped, so an old response can never overwrite newer data.
 * - A hidden tab does not poll; becoming visible again polls at once.
 * - Errors back off (doubling, capped at a minute or the interval) and keep the last good data: `error` + `updatedAt` let the page say
 *   "connection lost, last updated Xs ago" instead of showing stale data as if it were fresh.
 * `reload` polls now (after an action) and resolves once that request has settled.
 */
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, ms = 3000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const fn = useRef(load);
  fn.current = load;
  const seq = useRef(0);
  const kick = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let alive = true, failures = 0, ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (force: boolean): Promise<void> => {
      clearTimeout(timer); timer = undefined;
      if (!alive || (!force && document.hidden)) return; // a hidden tab resumes on visibilitychange
      const id = ++seq.current;
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      try {
        const v = await fn.current(c.signal);
        if (!alive || id !== seq.current) return; // superseded: the newer request owns the loop now
        setData(v); setError(null); setUpdatedAt(Date.now()); failures = 0;
      } catch (e) {
        if (!alive || id !== seq.current) return;
        setError((e as Error).message || "request failed"); failures++;
      } finally { if (ctrl === c) ctrl = null; }
      timer = setTimeout(() => void run(false), nextDelay(ms, failures));
    };
    kick.current = () => run(true);
    const onVisible = () => { if (!document.hidden) void run(false); };
    document.addEventListener("visibilitychange", onVisible);
    void run(true);
    return () => { alive = false; clearTimeout(timer); ctrl?.abort(); document.removeEventListener("visibilitychange", onVisible); };
  }, [ms, ...deps]);

  const reload = useCallback(() => kick.current(), []);
  return { data, error, updatedAt, reload };
}
