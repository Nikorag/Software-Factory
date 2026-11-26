import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Link2, Unplug } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, send } from "@/lib/api";
import type { JiraCheck, JiraMapping, JiraMetadata, JiraStatus } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { withTracker } from "@/lib/trackers";

const NONE = "__none";
const ROLE_LABELS: Record<string, [string, string]> = {
  readyForSpecification: ["Ready for specification", "The pickup status: automatic mode picks up tickets in this status that carry the opt-in label. Not needed in manual mode."],
  specificationReview: ["Specification review", "While the factory analyses the ticket and writes and reviews its specification."],
  readyForDevelopment: ["Ready for development", "Optional: not used by the factory today."],
  inProgress: ["In progress", "While it implements, tests and reviews the change."],
  readyForReview: ["Ready for review", "When the pull request is open and waiting for a person."],
  changesRequested: ["Changes requested", "Optional: not used by the factory today."],
  merging: ["Merging", "Optional: the factory never merges, so it never uses this."],
  done: ["Done", "When the ticket is finished."],
  blocked: ["Blocked", "When the factory needs a person (a question, a failed check, a limit reached)."],
};
const LABEL_ROLES: [string, string, string][] = [
  ["enabled", "Opt-in label", "Automatic mode only picks up tickets that carry this."],
  ["blocked", "Blocked label", "Added while the factory needs a person; removed when it carries on."],
  ["autonomous", "Autonomous label", "Optional: lets a ticket skip the human pause (only if the project is set to full autonomy)."],
  ["bugfix", "Bug fix label", "Optional: chooses the bug-fix workflow."], ["feature", "Feature label", "Optional: chooses the feature workflow."], ["maintenance", "Maintenance label", "Optional: chooses the maintenance workflow."],
];

/** Connect Jira with an OAuth app, then map the factory's statuses and labels onto what already exists in your Jira (the factory cannot create statuses there). */
export function JiraSetup({ onChanged, trackerId }: { onChanged?: () => void; trackerId?: string }) {
  const t = (p: string) => withTracker(p, trackerId, "jira"); // the built-in "jira" connection is the server's default
  const { data: st, reload } = usePoll(() => api<JiraStatus>(t("/api/jira/status")), 2500);
  const [clientId, setClientId] = useState(""), [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (st?.clientId) setClientId((c) => c || st.clientId!); }, [st?.clientId]);
  const changed = () => { void reload(); onChanged?.(); };

  const saveApp = async () => { const r = await send("PUT", t("/api/jira/app"), { clientId, clientSecret: secret }); if (r.ok) { setSecret(""); setMsg({ ok: true, text: "Saved. The secret is in your keychain." }); changed(); } else setMsg({ ok: false, text: r.error }); };
  const connect = async () => {
    const r = await send<{ url: string }>("POST", t("/api/jira/connect"), {});
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    window.open(r.data.url, "_blank", "noopener,noreferrer"); // the system browser: sign in to Atlassian there, then come back
    setMsg({ ok: true, text: "Approve access in the browser tab that opened, then return here." });
  };
  const pickSite = async (id: string) => { const r = await send("POST", t("/api/jira/site"), { cloudId: id }); if (r.ok) changed(); else setMsg({ ok: false, text: r.error }); };
  const disconnect = async () => { await send("POST", t("/api/jira/disconnect"), {}); changed(); };
  if (!st) return null;
  const ready = Boolean(st.clientId && st.secretSet);

  return (
    <div className="grid gap-5">
      <section className="grid gap-3">
        <h4 className="text-sm font-semibold">1. Your Atlassian OAuth app</h4>
        <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
          <li>Open the <a className="inline-flex items-center gap-1 underline" href="https://developer.atlassian.com/console/myapps/" target="_blank" rel="noopener noreferrer">Atlassian developer console<ExternalLink className="size-3" /></a> and create an <b>OAuth 2.0 (3LO)</b> app.</li>
          <li>Under <b>Permissions</b>, add the <b>Jira API</b> and give it the scopes <code>read:jira-work</code>, <code>write:jira-work</code> and <code>read:jira-user</code>.</li>
          <li>Under <b>Authorization</b>, set the callback URL to <code className="select-all rounded bg-muted px-1.5 py-0.5 text-xs" data-testid="callback">{st.callbackUrl}</code> (each profile has its own port, so its own app or callback).</li>
          <li>Copy the app's <b>Client ID</b> and <b>Secret</b> from <b>Settings</b> below.</li>
        </ol>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="jira-cid">Client ID</Label><Input id="jira-cid" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></div>
          <div className="grid gap-1.5"><Label htmlFor="jira-sec">Client secret {st.secretSet ? "(saved: paste to replace)" : ""}</Label><Input id="jira-sec" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></div>
        </div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!clientId || (!secret && !st.secretSet)} onClick={() => void saveApp()}>Save app</Button>
          <Button disabled={!ready} onClick={() => void connect()}><Link2 />{st.connected ? "Reconnect" : "Connect Jira"}</Button>
          {st.connected ? <Button variant="ghost" onClick={() => void disconnect()}><Unplug />Disconnect</Button> : null}</div>
        {st.connected && st.site ? <p className="flex items-center gap-2 text-sm text-ok"><CheckCircle2 className="size-4" />Connected to {st.site.name} <span className="text-muted-foreground">({st.site.url})</span></p> : null}
        {st.connected && !st.site && st.siteChoices.length ? (
          <div className="grid gap-1.5 text-sm"><b>Which Jira site?</b><div className="flex flex-wrap gap-2">{st.siteChoices.map((s) => <Button key={s.id} variant="outline" size="sm" onClick={() => void pickSite(s.id)}>{s.name} <span className="text-muted-foreground">{s.url.replace("https://", "")}</span></Button>)}</div></div>
        ) : null}
        {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
      </section>
      {st.connected && st.site ? <Mapping trackerId={trackerId} /> : <p className="text-sm text-muted-foreground">Connect Jira to map its statuses and labels.</p>}
    </div>
  );
}

function Mapping({ trackerId }: { trackerId?: string }) {
  const t = (p: string) => withTracker(p, trackerId, "jira");
  const { data: map, reload: reloadMap } = usePoll(() => api<JiraMapping>(t("/api/jira/mapping")), 600000);
  const [project, setProject] = useState<string | undefined>(undefined);
  const { data: meta, error: metaErr } = usePoll(() => api<JiraMetadata>(t(`/api/jira/metadata${project ? `?project=${encodeURIComponent(project)}` : ""}`)), 120000, [project]);
  const { data: check, reload: reloadCheck } = usePoll(() => api<JiraCheck>(t("/api/jira/mapping/check")), 120000);
  const [draft, setDraft] = useState<{ statuses: Record<string, string>; labels: Record<string, string> } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (map && !draft) setDraft({ statuses: { ...map.statuses }, labels: { ...map.labels } }); }, [map, draft]);
  if (!map || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify({ statuses: map.statuses, labels: map.labels });
  const need = new Set(map.required.statuses), needL = new Set(map.required.labels);
  const missingRequired = [...need].filter((k) => !draft.statuses[k]);
  const save = async () => { const r = await send("PUT", t("/api/jira/mapping"), draft); if (r.ok) { setMsg({ ok: true, text: "Saved. Applied immediately." }); setDraft(null); void reloadMap(); void reloadCheck(); } else setMsg({ ok: false, text: r.error }); };

  return (
    <section className="grid gap-3">
      <div><h4 className="text-sm font-semibold">2. Map the factory's statuses and labels to your Jira</h4>
        <p className="text-sm text-muted-foreground">The factory cannot create statuses in Jira (your admins own the workflow), so each one it uses is matched to a status that already exists. Anything left as “not used” is simply never set. Moving a ticket also needs a workflow transition to that status: if your workflow has none, the factory reports it and carries on.</p></div>
      {meta && meta.projects.length > 1 ? (
        <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">Showing the statuses of Jira project</span>
          <Select value={project ?? meta.project ?? NONE} onValueChange={setProject}><SelectTrigger className="w-56" aria-label="Jira project"><SelectValue /></SelectTrigger>
            <SelectContent>{meta.projects.map((p) => <SelectItem key={p.key} value={p.key}>{p.key} · {p.name}</SelectItem>)}</SelectContent></Select></div>
      ) : null}
      {metaErr ? <Alert variant="destructive"><AlertDescription>Could not read Jira: {metaErr}</AlertDescription></Alert> : null}
      <div className="grid gap-2" role="group" aria-label="Status mapping">
        {Object.entries(ROLE_LABELS).map(([key, [label, hint]]) => (
          <div key={key} className="grid items-center gap-1 sm:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="min-w-0"><div className="text-sm font-medium">{label}{need.has(key) ? <span className="ml-1 text-xs text-loop">required</span> : null}</div><div className="text-xs text-muted-foreground">{hint}</div></div>
            <Select value={draft.statuses[key] || NONE} onValueChange={(v) => { setMsg(null); setDraft({ ...draft, statuses: { ...draft.statuses, [key]: v === NONE ? "" : v } }); }}>
              <SelectTrigger aria-label={`${label} status`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>(not used)</SelectItem>{[...new Set([...(meta?.statuses ?? []), ...(draft.statuses[key] ? [draft.statuses[key]!] : [])])].map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent></Select>
          </div>
        ))}
      </div>
      <div className="grid gap-2" role="group" aria-label="Label mapping">
        <datalist id="jira-labels">{(meta?.labels ?? []).map((l) => <option key={l} value={l} />)}</datalist>
        {LABEL_ROLES.map(([key, label, hint]) => (
          <div key={key} className="grid items-center gap-1 sm:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="min-w-0"><div className="text-sm font-medium">{label}{needL.has(key) ? <span className="ml-1 text-xs text-loop">required</span> : null}</div><div className="text-xs text-muted-foreground">{hint}</div></div>
            <Input list="jira-labels" aria-label={`${label}`} className="font-mono text-xs" value={draft.labels[key] ?? ""} placeholder="(not used)" onChange={(e) => { setMsg(null); setDraft({ ...draft, labels: { ...draft.labels, [key]: e.target.value.replace(/\s/g, "") } }); }} />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Jira labels cannot contain spaces. A label does not need to exist yet: Jira creates it the first time the factory adds it. Pick an existing one to reuse your naming.</p>
      </div>
      {missingRequired.length ? <Alert><AlertDescription>Still to map: {missingRequired.map((k) => ROLE_LABELS[k]![0]).join(", ")}. The factory will not move tickets through those steps until you do.</AlertDescription></Alert> : null}
      {check ? (
        <div className="grid gap-1 text-sm">
          {check.projects.map((p) => (
            <div key={p.projectId} className={p.found && p.missing.length === 0 ? "text-ok" : "text-loop"}>
              {p.found ? (p.missing.length ? `Project ${p.projectId} (${p.jiraProject}): these statuses do not exist there: ${p.missing.join("; ")}` : `Project ${p.projectId} (${p.jiraProject}): every mapped status exists`) : `Project ${p.projectId}: Jira project ${p.jiraProject} was not found`}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-3">{msg ? <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-ok" : "text-sm text-destructive"}>{msg.text}</span> : null}<span className="flex-1" />
        <Button variant="outline" disabled={!dirty} onClick={() => setDraft(null)}>Revert</Button><Button disabled={!dirty} onClick={() => void save()}>Save mapping</Button></div>
    </section>
  );
}
