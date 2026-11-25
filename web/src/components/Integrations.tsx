import { useState } from "react";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, send } from "@/lib/api";
import { ago } from "@/lib/format";
import type { HealthReport, SetupInfo, TeamAudit } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

/** What to do when a dependency is not ready, keyed by the health probe's name. */
const HELP: Record<string, string> = {
  "claude code": "Install Claude Code, run `claude`, then /login with your Claude subscription. The factory uses that login: no API key.",
  github: "Install the GitHub CLI (`brew install gh`) and run `gh auth login`.",
  sandbox: "Needs macOS (sandbox-exec). Project commands are refused without it, by design.",
  "spec kit": "Install with `uv tool install specify-cli` (needs uv: `brew install uv`).",
  linear: "Add your Linear API key below.",
};
const Icon = ({ s }: { s: string }) => (s === "ok" ? <CheckCircle2 className="size-4 text-ok" /> : s === "warn" ? <CircleAlert className="size-4 text-loop" /> : <XCircle className="size-4 text-destructive" />);

/** Live status of every integration the factory depends on, with the fix when one is not ready. */
export function Checks({ onChange }: { onChange?: (ok: boolean) => void }) {
  const { data, reload } = usePoll(async () => { const r = await api<HealthReport>("/api/health"); onChange?.(r.health.every((h) => h.status === "ok" || h.name === "spec kit" || h.name === "local model")); return r; }, 5000);
  return (
    <div className="grid gap-2">
      {(data?.health ?? []).map((h) => (
        <div key={h.name} className="flex gap-3 rounded-md border p-3 text-sm">
          <Icon s={h.status} />
          <div className="min-w-0 flex-1"><div className="font-medium capitalize">{h.name}</div><div className="text-muted-foreground">{h.detail}</div>
            {h.status !== "ok" && HELP[h.name] ? <div className="mt-1 text-xs">{HELP[h.name]}</div> : null}</div>
          <span className="text-xs text-muted-foreground">{ago(h.checkedAt)}</span>
        </div>
      ))}
      <div><Button variant="outline" size="sm" onClick={() => void reload()}>Re-check</Button></div>
    </div>
  );
}

/** Linear: paste a key (validated before it is stored in the macOS keychain), then see each team and create the statuses/labels the factory needs. */
export function LinearSetup({ info, onKey, onTeams }: { info: SetupInfo | null; onKey?: () => void; onTeams?: (t: TeamAudit[]) => void }) {
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { data, error, reload } = usePoll(async () => { const r = await api<{ teams: TeamAudit[] }>("/api/setup/linear"); onTeams?.(r.teams); return r; }, 60000, [info?.linear.keyPresent]);
  const save = async () => {
    const r = await send<{ name: string }>("POST", "/api/setup/linear-key", { key });
    if (r.ok) { setKey(""); setMsg({ ok: true, text: `Connected to Linear as ${r.data.name}. The key is stored in your keychain.` }); onKey?.(); void reload(); } else setMsg({ ok: false, text: r.error });
  };
  const create = async (team: string) => { const r = await send<{ created: string[]; failed: { action: string; error: string }[] }>("POST", `/api/setup/linear/${team}/create`); setMsg(r.ok ? { ok: r.data.failed.length === 0, text: `Created: ${r.data.created.join(", ") || "nothing"}${r.data.failed.length ? `. Failed: ${r.data.failed.map((f) => f.error).join("; ")}` : ""}` } : { ok: false, text: r.error }); void reload(); };
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="lin-key">Linear personal API key {info?.linear.keyPresent ? "(one is already set: paste to replace it)" : ""}</Label>
        <div className="flex gap-2"><Input id="lin-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="lin_api_…" /><Button disabled={!key} onClick={() => void save()}>Verify &amp; save</Button></div>
        <p className="text-xs text-muted-foreground">Create one at Linear → Settings → Account → Security &amp; access → Personal API keys. It is checked against Linear, then stored in your macOS keychain, never in a file.</p>
      </div>
      {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
      {error && info?.linear.keyPresent ? <Alert variant="destructive"><AlertDescription>Could not read Linear: {error}</AlertDescription></Alert> : null}
      {(data?.teams ?? []).map((t) => {
        const missing = [...t.audit.statuses, ...t.audit.labels];
        return (
          <div key={t.key} className="rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2"><b>{t.key}</b><span className="text-muted-foreground">{t.name} · {t.projects.length} project(s)</span><span className="flex-1" />
              {missing.length === 0 ? <span className="flex items-center gap-1 text-ok"><CheckCircle2 className="size-4" />ready</span> : (
                <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="outline">Create {missing.length} missing</Button></AlertDialogTrigger>
                  <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Create in Linear team {t.key}?</AlertDialogTitle>
                    <AlertDialogDescription>This adds these to your Linear workspace (it never edits or deletes anything): {missing.map((m) => m.name).join(", ")}.</AlertDialogDescription></AlertDialogHeader>
                    <AlertDialogFooter><AlertDialogCancel>Not now</AlertDialogCancel><AlertDialogAction onClick={() => void create(t.key)}>Create them</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
              )}</div>
            {missing.length ? <div className="mt-1 text-xs text-muted-foreground">Missing: {missing.map((m) => `${m.name}${m.required ? "" : " (optional)"}`).join(", ")}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
