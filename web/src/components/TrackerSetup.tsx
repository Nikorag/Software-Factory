import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { send } from "@/lib/api";
import type { SetupInfo, TeamAudit } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GithubIssuesSetup } from "./GithubIssuesSetup";
import { JiraSetup } from "./JiraSetup";
import { LinearSetup } from "./Integrations";

/** Which tracker this profile uses (Linear, Jira or GitHub Issues, per profile), and connecting it. */
const NAME = { linear: "Linear", jira: "Jira", github: "GitHub Issues" } as const;
export function TrackerSetup({ info, onChanged, onKey, onTeams }: { info: SetupInfo | null; onChanged?: () => void; onKey?: () => void; onTeams?: (t: TeamAudit[]) => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<"linear" | "jira" | "github" | null>(null);
  if (!info) return null;
  const kind = info.tracker?.kind ?? "linear";
  const choose = async (k: "linear" | "jira" | "github") => {
    setPending(null);
    const r = await send<{ note?: string }>("PUT", "/api/settings/tracker", { tracker: k });
    setMsg(r.ok ? { ok: true, text: r.data.note ?? `Now using ${NAME[k]}.` } : { ok: false, text: r.error });
    onChanged?.();
  };
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="text-sm font-medium">Issue tracker for this profile</div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Issue tracker">
          {(["linear", "jira", "github"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => (k === kind ? undefined : setPending(k))}
              className={cn("rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent", kind === k && "border-foreground bg-accent")}>{NAME[k]}</button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Each profile picks its own: a “home” profile can use Linear while a “work” profile uses Jira or GitHub Issues.</p>
      </div>
      {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
      {kind === "jira" ? <JiraSetup onChanged={onChanged} /> : kind === "github" ? <GithubIssuesSetup onChanged={onChanged} onTeams={onTeams} /> : <LinearSetup info={info} onKey={onKey} onTeams={onTeams} />}
      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Switch this profile to {pending ? NAME[pending] : ""}?</AlertDialogTitle>
          <AlertDialogDescription>Projects stay as they are but are linked to a {NAME[kind]} project, so each one needs re-linking afterwards. Switching is refused while any job is still active.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep {NAME[kind]}</AlertDialogCancel><AlertDialogAction onClick={() => pending && void choose(pending)}>Switch</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
