import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JobsTable } from "@/components/JobsTable";
import { api } from "@/lib/api";
import type { Job, Project } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

const ALL = "__all";
export function Jobs() {
  const [status, setStatus] = useState(ALL), [proj, setProj] = useState(ALL);
  const { data } = usePoll(async () => {
    const q = new URLSearchParams();
    if (status !== ALL) q.set("status", status);
    if (proj !== ALL) q.set("project", proj);
    const [jobs, ps] = await Promise.all([api<{ jobs: Job[] }>(`/api/jobs?${q}`), api<{ projects: Project[] }>("/api/projects")]);
    return { jobs: jobs.jobs, projects: ps.projects };
  }, 3000, [status, proj]);
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <Select value={status} onValueChange={setStatus}><SelectTrigger className="w-40" aria-label="status filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>any status</SelectItem>{["running", "queued", "waiting", "done", "failed", "cancelled"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
        <Select value={proj} onValueChange={setProj}><SelectTrigger className="w-48" aria-label="project filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>any project</SelectItem>{(data?.projects ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.id}</SelectItem>)}</SelectContent></Select>
      </div>
      <Card><CardContent><JobsTable jobs={data?.jobs ?? []} /></CardContent></Card>
    </div>
  );
}
