import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JobsTable } from "@/components/JobsTable";
import { Pager } from "@/components/Pager";
import { api, send } from "@/lib/api";
import type { Job, Project } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

const ALL = "__all";
interface Page { jobs: Job[]; total: number; page: number; pages: number; pageSize: number }

export function Jobs() {
  const [status, setStatus] = useState(ALL), [proj, setProj] = useState(ALL), [archived, setArchived] = useState("hide");
  const [text, setText] = useState(""), [q, setQ] = useState("");
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => { setPage(1); }, [status, proj, archived, q, pageSize]);
  const { data, reload } = usePoll(async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), archived });
    if (status !== ALL) qs.set("status", status);
    if (proj !== ALL) qs.set("project", proj);
    if (q) qs.set("q", q);
    const [jobs, ps] = await Promise.all([api<Page>(`/api/jobs?${qs}`), api<{ projects: Project[] }>("/api/projects")]);
    return { ...jobs, projects: ps.projects };
  }, 3000, [status, proj, archived, q, page, pageSize]);
  const act = async (r: ReturnType<typeof send>) => { const res = await r; setMsg(res.ok ? null : res.error); void reload(); };
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="flex flex-wrap gap-2">
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search jobs" className="pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ticket, project, stage or error" /></div>
        <Select value={status} onValueChange={setStatus}><SelectTrigger className="w-40" aria-label="status filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>any status</SelectItem>{["running", "queued", "waiting", "done", "failed", "cancelled"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
        <Select value={proj} onValueChange={setProj}><SelectTrigger className="w-48" aria-label="project filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>any project</SelectItem>{(data?.projects ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.id}</SelectItem>)}</SelectContent></Select>
        <Select value={archived} onValueChange={setArchived}><SelectTrigger className="w-44" aria-label="archive filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="hide">not archived</SelectItem><SelectItem value="only">archived only</SelectItem><SelectItem value="all">everything</SelectItem></SelectContent></Select>
      </div>
      {msg ? <Alert variant="destructive"><AlertDescription>{msg}</AlertDescription></Alert> : null}
      <Card><CardContent>
        <JobsTable jobs={data?.jobs ?? []} actions={{ archive: (j, a) => void act(send("POST", `/api/jobs/${j.id}/${a ? "archive" : "unarchive"}`)), remove: (j) => void act(send("DELETE", `/api/jobs/${j.id}`)) }} />
        {data ? <Pager page={data.page} pages={data.pages} pageSize={data.pageSize} total={data.total} onPage={setPage} onPageSize={setPageSize} /> : null}
      </CardContent></Card>
    </div>
  );
}
