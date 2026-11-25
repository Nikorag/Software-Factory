import { useCallback, useEffect, useRef, useState } from "react";

/** Loads on mount and every `ms` while the tab is visible. `reload` forces a refresh (after an action). */
export function usePoll<T>(load: () => Promise<T>, ms = 3000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fn = useRef(load);
  fn.current = load;
  const reload = useCallback(async () => {
    try { setData(await fn.current()); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => { if (!document.hidden) void reload(); }, ms);
    return () => clearInterval(t);
  }, [ms, reload, ...deps]);
  return { data, error, reload };
}
