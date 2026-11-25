import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAGE_SIZES } from "@/lib/paging";

/** "1–25 of 140", previous/next and a page-size picker. Renders nothing when everything fits on one page at the smallest size. */
export function Pager({ page, pages, pageSize, total, onPage, onPageSize }: { page: number; pages: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void }) {
  if (total <= PAGE_SIZES[0]) return null;
  const from = (page - 1) * pageSize + 1, to = Math.min(total, page * pageSize);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" role="navigation" aria-label="Pagination">
      <span>{from}–{to} of {total}</span>
      <div className="flex items-center gap-2">
        {onPageSize ? (
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-28" aria-label="rows per page"><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n} per page</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
        <Button size="sm" variant="outline" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
        <span className="tabular-nums">Page {page} of {pages}</span>
        <Button size="sm" variant="outline" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
      </div>
    </div>
  );
}
