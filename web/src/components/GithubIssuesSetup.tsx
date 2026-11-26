import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, send } from "@/lib/api";
import { withTracker } from "@/lib/trackers";
import type { GhAccounts, GithubIssuesMapping, TeamAudit } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

const STATUSES: [string, string, string][] = [
  ["readyForSpecification", "Ready for specification", "The pickup status: automatic mode picks up issues with this status label and the opt-in label."],
  ["specificationReview", "Specification review", "While the factory analyses the issue and writes and reviews its specification."],
  ["readyForDevelopment", "Ready for development", "Optional: not used by the factory today."],
  ["inProgress", "In progress", "While it implements, tests and reviews the change."],
  ["readyForReview", "Ready for review", "When the pull request is open and waiting for a person."],
  ["changesRequested", "Changes requested", "Optional: not used by the factory today."],
  ["merging", "Merging", "Optional: the factory never merges, so it never uses this."],
  ["done", "Done", "When the issue is finished. The issue is also closed."],
  ["blocked", "Blocked", "When the factory needs a person (a question, a failed check, a limit reached)."],
];
const LABELS: [string, string][] = [
  ["enabled", "Opt-in label"], ["blocked", "Blocked label"], ["autonomous", "Autonomous label"], ["bugfix", "Bug fix label"], ["feature", "Feature label"], ["maintenance", "Maintenance label"],
];
const DEFAULT_ACCOUNT = "__default";

/**
 * GitHub Issues needs no app or key: it signs in with a `gh` login (the profile's account, or one chosen for this connection). What is left is the
 * names the factory uses (workflow statuses are labels with a prefix, because an issue is only open or closed), and creating the missing ones in
 * each linked repository.
 */
export function GithubIssuesSetup({ onChanged, onTeams, trackerId, defaultId = "github" }: { onChanged?: () => void; onTeams?: (t: TeamAudit[]) => void; trackerId?: string; defaultId?: string }) {
  const g = (p: string) => withTracker(p, trackerId, "github");   // the built-in "github" connection is the server's default for these routes
  const s = (p: string) => withTracker(p, trackerId, defaultId);  // the setup routes default to the profile's default tracker
  const { data: who, error: whoErr, reload: reloadWho } = usePoll(() => api<{ name: string }>(g("/api/github-issues/whoami")), 300000, [trackerId]);
  const { data: map, reload: reloadMap } = usePoll(() => api<GithubIssuesMapping>(g("/api/github-issues/mapping")), 600000, [trackerId]);
  const { data: accounts } = usePoll(() => api<GhAccounts>("/api/setup/github"), 120000);
  const { data: teams, error: teamsErr, reload: reloadTeams } = usePoll(async () => { const r = await api<{ teams: TeamAudit[] }>(s("/api/setup/linear")); if (!trackerId || trackerId === defaultId) onTeams?.(r.teams); return r; }, 60000, [trackerId]);
  const [draft, setDraft] = useState<GithubIssuesMapping | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (map && !draft) setDraft({ statusPrefix: map.statusPrefix, statuses: { ...map.statuses }, labels: { ...map.labels }, account: map.account ?? null }); }, [map, draft]);
  useEffect(() => { setDraft(null); }, [trackerId]);

  const save = async () => { const r = await send("PUT", g("/api/github-issues/mapping"), draft); if (r.ok) { setMsg({ ok: true, text: "Saved. Applied immediately." }); setDraft(null); void reloadMap(); void reloadTeams(); void reloadWho(); onChanged?.(); } else setMsg({ ok: false, text: r.error }); };
  const create = async (repo: string) => {
    const r = await send<{ created: string[]; failed: { action: string; error: string }[] }>("POST", s(`/api/setup/linear/${encodeURIComponent(repo)}/create`)); // owner/name has a slash: it must be encoded to stay one path segment
    setMsg(r.ok ? { ok: r.data.failed.length === 0, text: `Created: ${r.data.created.join(", ") || "nothing"}${r.data.failed.length ? `. Failed: ${r.data.failed.map((f) => `${f.action} (${f.error})`).join("; ")}` : ""}` } : { ok: false, text: r.error });
    void reloadTeams();
  };
  const dirty = map && draft ? JSON.stringify(draft) !== JSON.stringify({ statusPrefix: map.statusPrefix, statuses: map.statuses, labels: map.labels, account: map.account ?? null }) : false;
  const linked = (teams?.teams ?? []).filter((t) => t.audited !== false);

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h4 className="text-sm font-semibold">1. GitHub sign-in</h4>
        <p className="text-sm text-muted-foreground">There is nothing to connect here: the factory uses a <code>gh</code> login, the same kind it uses for pull requests. That account needs access to issues in each repository you link.</p>
        {draft ? (
          <div className="grid max-w-xs gap-1.5"><Label htmlFor="gh-account">GitHub account for this connection</Label>
            <select id="gh-account" aria-label="GitHub account" className="h-9 rounded-md border bg-transparent px-2 text-sm" value={draft.account ?? DEFAULT_ACCOUNT} onChange={(e) => { setMsg(null); setDraft({ ...draft, account: e.target.value === DEFAULT_ACCOUNT ? null : e.target.value }); }}>
              <option value={DEFAULT_ACCOUNT}>(the profile's default account)</option>
              {[...new Set([...(accounts?.accounts ?? []).map((a) => a.login), ...(draft.account ? [draft.account] : [])])].map((l) => <option key={l} value={l}>{l}</option>)}
            </select></div>
        ) : null}
        {who ? <p className="flex items-center gap-2 text-sm text-ok"><CheckCircle2 className="size-4" />Signed in to GitHub as {who.name}</p> : null}
        {whoErr ? <Alert variant="destructive"><AlertDescription>GitHub did not accept the login: {whoErr}. Run <code>gh auth login</code> and try again.</AlertDescription></Alert> : null}
      </section>
      <section className="grid gap-3">
        <div><h4 className="text-sm font-semibold">2. Statuses and labels</h4>
          <p className="text-sm text-muted-foreground">An issue is only open or closed, so each workflow status is a label that starts with the prefix below (for example <code>{draft?.statusPrefix ?? "status: "}In progress</code>). The factory keeps exactly one of them on an issue, closes the issue on “Done” and reopens it for any other status. Rename them if you already have your own.</p></div>
        {draft ? (
          <>
            <div className="grid max-w-xs gap-1.5"><Label htmlFor="gh-prefix">Status label prefix</Label><Input id="gh-prefix" className="font-mono text-xs" value={draft.statusPrefix} onChange={(e) => { setMsg(null); setDraft({ ...draft, statusPrefix: e.target.value }); }} /></div>
            <div className="grid gap-2" role="group" aria-label="Status names">
              {STATUSES.map(([key, label, hint]) => (
                <div key={key} className="grid items-center gap-1 sm:grid-cols-[minmax(0,1fr)_16rem]">
                  <div className="min-w-0"><div className="text-sm font-medium">{label}</div><div className="text-xs text-muted-foreground">{hint}</div></div>
                  <Input aria-label={`${label} status`} className="font-mono text-xs" value={draft.statuses[key] ?? ""} placeholder="(not used)" onChange={(e) => { setMsg(null); setDraft({ ...draft, statuses: { ...draft.statuses, [key]: e.target.value } }); }} />
                </div>
              ))}
            </div>
            <div className="grid gap-2" role="group" aria-label="Label names">
              {LABELS.map(([key, label]) => (
                <div key={key} className="grid items-center gap-1 sm:grid-cols-[minmax(0,1fr)_16rem]">
                  <div className="text-sm font-medium">{label}</div>
                  <Input aria-label={label} className="font-mono text-xs" value={draft.labels[key] ?? ""} placeholder="(not used)" onChange={(e) => { setMsg(null); setDraft({ ...draft, labels: { ...draft.labels, [key]: e.target.value } }); }} />
                </div>
              ))}
            </div>
            <div className="flex gap-2"><Button disabled={!dirty} onClick={() => void save()}>Save</Button>{dirty ? <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button> : null}</div>
          </>
        ) : null}
      </section>
      <section className="grid gap-3">
        <h4 className="text-sm font-semibold">3. Create what is missing in your repositories</h4>
        {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
        {teamsErr ? <Alert variant="destructive"><AlertDescription>Could not read GitHub: {teamsErr}</AlertDescription></Alert> : null}
        {linked.length === 0 && !teamsErr ? <p className="text-sm text-muted-foreground">Link a project to a repository (Settings → Projects) and its labels are checked here.</p> : null}
        {linked.map((t) => {
          const missing = [...t.audit.statuses, ...t.audit.labels];
          return (
            <div key={t.key} className="rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2"><b>{t.key}</b><span className="text-muted-foreground">{t.projects.length} milestone(s)</span><span className="flex-1" />
                {missing.length === 0 ? <span className="flex items-center gap-1 text-ok"><CheckCircle2 className="size-4" />ready</span> : (
                  <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="outline">Create {missing.length} missing</Button></AlertDialogTrigger>
                    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Create labels in {t.key}?</AlertDialogTitle>
                      <AlertDialogDescription>This adds these labels to the repository (it never edits or deletes anything): {missing.map((m) => m.name).join(", ")}.</AlertDialogDescription></AlertDialogHeader>
                      <AlertDialogFooter><AlertDialogCancel>Not now</AlertDialogCancel><AlertDialogAction onClick={() => void create(t.key)}>Create them</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
                )}</div>
              {missing.length ? <div className="mt-1 text-xs text-muted-foreground">Missing: {missing.map((m) => `${m.name}${m.required ? "" : " (optional)"}`).join(", ")}</div> : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}
