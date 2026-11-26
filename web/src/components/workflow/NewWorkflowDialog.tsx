import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createWorkflow } from "@/lib/workflow-api";
import type { WorkflowListItem } from "@/lib/workflows";
import { Pick } from "./fields";
import { cn } from "@/lib/utils";

type Source = "scratch" | "default" | "copy";
const SOURCES: { v: Source; label: string; hint: string }[] = [
  { v: "scratch", label: "From scratch", hint: "A minimal valid workflow: the mandatory eligibility check, one read-only analysis step and completion." },
  { v: "default", label: "From the Default Workflow", hint: "A copy of the factory's standard process, ready to change." },
  { v: "copy", label: "Copy of another workflow", hint: "Start from any workflow in the library." },
];

export function NewWorkflowDialog({ open, onClose, workflows }: { open: boolean; onClose: () => void; workflows: WorkflowListItem[] }) {
  const nav = useNavigate();
  const [name, setName] = useState(""), [desc, setDesc] = useState(""), [source, setSource] = useState<Source>("default"), [from, setFrom] = useState<string | undefined>();
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const src = source === "scratch" ? undefined : source === "default" ? "default" : from ?? workflows[0]?.id;
  const create = async () => {
    setBusy(true); setErr(null);
    const r = await createWorkflow({ name: name.trim(), description: desc }, src);
    setBusy(false);
    if (r.ok) { onClose(); nav(`/workflows/${encodeURIComponent(r.data.workflow.id)}`); } else setErr(r.error);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>New workflow</DialogTitle><DialogDescription>You can change everything afterwards in the editor.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label htmlFor="nw-name">Name</Label><Input id="nw-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Docs-only changes" /></div>
          <div className="grid gap-1.5"><Label htmlFor="nw-desc">Description</Label><Input id="nw-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" /></div>
          <div className="grid gap-2" role="radiogroup" aria-label="Start from">
            {SOURCES.map((s) => (
              <button key={s.v} type="button" role="radio" aria-checked={source === s.v} onClick={() => setSource(s.v)} className={cn("grid gap-0.5 rounded-md border p-2.5 text-left text-sm transition-colors hover:bg-accent", source === s.v && "border-foreground bg-accent")}><b>{s.label}</b><span className="text-xs text-muted-foreground">{s.hint}</span></button>
            ))}
          </div>
          {source === "copy" ? <Pick label="Workflow to copy" value={src} onChange={setFrom} options={workflows.map((w) => ({ value: w.id, label: w.name }))} className="w-full" /> : null}
          {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || busy || (source === "copy" && !src)} onClick={() => void create()}>Create</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
