import { useEffect, useMemo, useState } from "react";

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** Case-insensitive "contains" over the given fields; an empty query matches everything. */
export function matches(query: string, ...fields: Array<string | number | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f !== null && f !== undefined && String(f).toLowerCase().includes(q));
}

/** Client-side paging for lists that are already in memory. Resets to page 1 when the list or filter changes; clamps if the list shrinks. */
export function usePaged<T>(items: T[], initialSize = 10) {
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(initialSize);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  useEffect(() => { setPage(1); }, [items.length, pageSize]);
  const slice = useMemo(() => items.slice((current - 1) * pageSize, current * pageSize), [items, current, pageSize]);
  return { slice, page: current, pages, pageSize, total: items.length, setPage, setPageSize };
}
