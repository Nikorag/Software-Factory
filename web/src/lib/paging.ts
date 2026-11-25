import { useCallback, useEffect, useMemo, useState } from "react";

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** Case-insensitive "contains" over the given fields; an empty query matches everything. */
export function matches(query: string, ...fields: Array<string | number | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f !== null && f !== undefined && String(f).toLowerCase().includes(q));
}

/** The page to show: the requested one, clamped to the pages that exist. */
export const clampPage = (page: number, total: number, pageSize: number): number => Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / pageSize)));

/**
 * Client-side paging for lists that are already in memory. Live lists grow and shrink on every poll, so a length change only clamps
 * (the page you are reading stays put); going back to page 1 happens only when `resetKey` (the filter/search) or the page size changes.
 */
export function usePaged<T>(items: T[], initialSize = 10, resetKey: unknown = null) {
  const [page, setPage] = useState(1), [pageSize, setSize] = useState(initialSize);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = clampPage(page, items.length, pageSize);
  useEffect(() => { if (page !== current) setPage(current); }, [page, current]); // a shrunk list keeps the last page, not a phantom one
  useEffect(() => { setPage(1); }, [resetKey]);
  const setPageSize = useCallback((n: number) => { setSize(n); setPage(1); }, []);
  const slice = useMemo(() => items.slice((current - 1) * pageSize, current * pageSize), [items, current, pageSize]);
  return { slice, page: current, pages, pageSize, total: items.length, setPage, setPageSize };
}
