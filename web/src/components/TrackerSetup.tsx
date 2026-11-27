import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, send } from "@/lib/api";
import { BUILTIN_ENTRIES, KIND_NAME } from "@/lib/trackers";
import type { SetupInfo, TeamAudit, TrackerEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { usePoll } from "@/hooks/usePoll";
import { GithubIssuesSetup } from "./GithubIssuesSetup";
import { JiraSetup } from "./JiraSetup";
import { LinearSetup } from "./Integrations";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The tracker connections of this profile. Each is an instance of Linear, Jira or GitHub Issues with its own credentials and mapping, and you
 * can have several of each (two Jiras, three Linear workspaces). One is the profile's default; every project may name its own instead.
 */
export function TrackerSetup({ info, onChanged, onKey, onTeams }: { info: SetupInfo | null; onChanged?: () => void; onKey?: () => void; onTeams?: (t: TeamAudit[]) => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);      // a connection to make the default, awaiting confirmation
  const [removing, setRemoving] = useState<TrackerEntry | null>(null);
  const [sel, setSel] = useState<string | null>(null);               // the connection being configured
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: "jira", id: "", label: "" });
  const defaultId = info?.tracker?.id ?? info?.tracker?.kind ?? "linear";
  const { data: list, reload } = usePoll(() => api<{ default: string; trackers: TrackerEntry[] }>("/api/trackers"), 20000);
  if (!info) return null;
  const entries = list?.trackers ?? BUILTIN_ENTRIES(defaultId);   // the three built-ins until the server's list arrives
  const defId = list?.default ?? defaultId;
  const active = entries.find((e) => e.id === sel) ?? entries.find((e) => e.id === defId) ?? entries[0]!;
  const changed = () => { void reload(); onChanged?.(); };
  const manyOrAdding = adding || entries.some((e) => !e.builtin);

  const choose = async (id: string) => {
    setPending(null);
    const r = await send<{ note?: string }>("PUT", "/api/settings/tracker", { tracker: id });
    const label = entries.find((e) => e.id === id)?.label ?? id;
    setMsg(r.ok ? { ok: true, text: r.data.note ?? `Now using ${label} as the default.` } : { ok: false, text: r.error });
    changed();
  };
  const add = async () => {
    const id = form.id || slug(form.label);
    const r = await send("POST", "/api/trackers", { id, kind: form.kind, ...(form.label.trim() ? { label: form.label.trim() } : {}) });
    if (r.ok) { setMsg({ ok: true, text: `Added ${form.label.trim() || id}. Set it up below, then choose it on a project.` }); setAdding(false); setForm({ kind: "jira", id: "", label: "" }); setSel(id); changed(); } else setMsg({ ok: false, text: r.error });
  };
  const remove = async (e: TrackerEntry) => {
    setRemoving(null);
    const r = await send("DELETE", `/api/trackers/${encodeURIComponent(e.id)}`);
    setMsg(r.ok ? { ok: true, text: `Removed ${e.label}. Its saved keychain entries were left alone.` } : { ok: false, text: r.error });
    setSel(null); changed();
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="text-sm font-medium">Default issue tracker for this profile</div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Issue tracker">
          {entries.map((e) => (
            <button key={e.id} type="button" role="radio" aria-checked={e.id === defId} onClick={() => (e.id === defId ? undefined : setPending(e.id))}
              className={cn("rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent max-md:min-h-11", e.id === defId && "border-foreground bg-accent")}>{e.label}</button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Projects use this unless they name their own tracker (Settings → Projects), so one profile can mix Linear, Jira and GitHub Issues, and you can have several of each.</p>
      </div>
      {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        {manyOrAdding ? (
          <>
            <Label htmlFor="trk-conf" className="text-sm font-medium">Set up</Label>
            <select id="trk-conf" aria-label="Tracker connection to set up" className="h-9 rounded-md border bg-transparent px-2 text-sm" value={active.id} onChange={(e) => setSel(e.target.value)}>
              {entries.map((e) => <option key={e.id} value={e.id}>{e.label}{e.id === defId ? " (default)" : ""}</option>)}
            </select>
          </>
        ) : null}
        {!adding ? <Button variant="outline" size="sm" onClick={() => setAdding(true)}>Add another tracker connection…</Button> : null}
        {active.projects.length ? <Badge variant="secondary">{active.projects.length} project{active.projects.length === 1 ? "" : "s"}</Badge> : null}
        {!active.builtin && active.id !== defId && active.projects.length === 0 ? <Button variant="ghost" size="sm" onClick={() => setRemoving(active)}><Trash2 />Remove</Button> : null}
      </div>

      {adding ? (
        <div className="grid gap-3 rounded-md border p-3" role="group" aria-label="Add a tracker connection">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label htmlFor="trk-kind">Kind</Label>
              <select id="trk-kind" className="h-9 rounded-md border bg-transparent px-2 text-sm" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {(Object.keys(KIND_NAME) as (keyof typeof KIND_NAME)[]).map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}
              </select></div>
            <div className="grid gap-1.5"><Label htmlFor="trk-label">Name</Label><Input id="trk-label" placeholder="Client Jira" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label htmlFor="trk-id">Id</Label><Input id="trk-id" className="font-mono text-xs" placeholder={slug(form.label) || "client-jira"} value={form.id} onChange={(e) => setForm({ ...form, id: slug(e.target.value) })} /></div>
          </div>
          <p className="text-xs text-muted-foreground">The id is what projects refer to (lowercase letters, numbers, hyphens). Each connection keeps its own credentials, so two of the same kind never mix.</p>
          <div className="flex gap-2"><Button disabled={!(form.id || slug(form.label))} onClick={() => void add()}>Add connection</Button><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
        </div>
      ) : null}

      <div key={active.id}>
        {active.kind === "jira" ? <JiraSetup trackerId={active.id} onChanged={changed} />
          : active.kind === "github" ? <GithubIssuesSetup trackerId={active.id} defaultId={defId} onChanged={changed} onTeams={active.id === defId ? onTeams : undefined} />
            : <LinearSetup info={info} trackerId={active.id} keyPresent={list ? active.connected : undefined} onKey={() => { void reload(); onKey?.(); }} onTeams={active.id === defId ? onTeams : undefined} />}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Switch this profile to {entries.find((e) => e.id === pending)?.label ?? pending}?</AlertDialogTitle>
          <AlertDialogDescription>Projects that follow the default are linked to a {entries.find((e) => e.id === defId)?.label ?? "tracker"} project, so each needs re-linking afterwards (or give it its own tracker and leave it as it is). Projects that name their own tracker are unaffected. Switching is refused while jobs of following projects are still active.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep {entries.find((e) => e.id === defId)?.label ?? "it"}</AlertDialogCancel><AlertDialogAction onClick={() => pending && void choose(pending)}>Switch</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
          <AlertDialogDescription>No project uses it. Its saved credentials stay in your keychain (delete them in Keychain Access if you want them gone).</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => removing && void remove(removing)}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
