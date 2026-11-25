import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, send } from "@/lib/api";
import type { TaskState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Shows the live output of a background action (clone, validate, check, onboard). Polls the task until it finishes. */
export function TaskOutput({ taskId, onDone }: { taskId: string; onDone?: (ok: boolean) => void }) {
  const [t, setT] = useState<TaskState | null>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api<TaskState>(`/api/tasks/${taskId}`);
        if (!live) return;
        setT(s);
        if (s.status === "running") timer = setTimeout(() => void tick(), 1000); else onDone?.(s.status === "ok");
      } catch { if (live) timer = setTimeout(() => void tick(), 2000); }
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line
  }, [taskId]);
  if (!t) return null;
  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <div className={cn("mb-1 flex items-center gap-2 text-sm font-medium", t.status === "ok" && "text-ok", t.status === "failed" && "text-destructive")}>
        {t.status === "running" ? <Loader2 className="size-4 animate-spin" /> : null}{t.label}: {t.status === "running" ? "running…" : t.status === "ok" ? "done" : "failed"}
      </div>
      <pre className="max-h-72 overflow-auto text-xs whitespace-pre-wrap">{t.lines.join("\n") || "…"}</pre>
    </div>
  );
}

export const startAction = (projectId: string, kind: string) => send<{ taskId: string }>("POST", `/api/projects/${encodeURIComponent(projectId)}/actions/${kind}`, {});
