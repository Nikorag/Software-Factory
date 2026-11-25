import { useState } from "react";
import { ArrowUpCircle, CheckCircle2, Copy, ExternalLink, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, send } from "@/lib/api";
import { ago } from "@/lib/format";
import type { UpdateInfo } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

/** Settings → System: the installed version, and a button that asks for the newest release right now. Updating itself stays a terminal command: replacing code under a running factory is something you choose. */
export function UpdateCheck() {
  const { data: cached, reload } = usePoll(() => api<UpdateInfo>("/api/update"), 30 * 60_000);
  const [fresh, setFresh] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const info = fresh ?? cached;

  const check = async () => {
    setBusy(true); setErr(null);
    const r = await send<UpdateInfo>("POST", "/api/update/check");
    setBusy(false);
    if (r.ok) { setFresh(r.data); void reload(); } else setErr(r.error);
  };
  const copy = async () => { try { await navigator.clipboard.writeText("software-factory update"); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the command is shown: select it */ } };

  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div><div className="text-xs text-muted-foreground">Installed version</div><div className="font-mono text-base font-semibold">{info?.version ? `v${info.version}` : info?.current ?? "unknown"}</div></div>
        <span className="flex-1" />
        <Button variant="outline" onClick={() => void check()} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}Check for updates</Button>
      </div>
      {err ? <p role="alert" className="flex items-center gap-2 text-destructive"><TriangleAlert className="size-4" />{err}</p> : null}
      {info?.error ? <p role="alert" className="flex items-center gap-2 text-loop"><TriangleAlert className="size-4" />Could not check for updates: {info.error}. This needs network access to GitHub.</p> : null}
      {info && !info.error && info.checkedAt ? (
        info.available ? (
          <div className="grid gap-2 rounded-md border border-run/40 bg-run/5 p-3">
            <div className="flex items-center gap-2 font-medium"><ArrowUpCircle className="size-4 text-run" />{info.latest} is available <span className="font-normal text-muted-foreground">(you have {info.current})</span></div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs">software-factory update</code>
              <Button size="sm" variant="ghost" onClick={() => void copy()}><Copy />{copied ? "Copied" : "Copy"}</Button>
              <a className="inline-flex items-center gap-1 text-xs underline" href="https://github.com/Nikorag/Software-Factory/releases" target="_blank" rel="noopener noreferrer">Release notes<ExternalLink className="size-3" /></a>
            </div>
            <p className="text-xs text-muted-foreground">Run it in a terminal, then restart the factory (<code>software-factory shutdown</code>, then <code>software-factory</code>). Pick a quiet moment: a restart redoes any stage that is in progress. Your settings and data are not touched.</p>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-ok"><CheckCircle2 className="size-4" />You're on the latest release. <span className="text-muted-foreground">Checked {ago(info.checkedAt)}.</span></p>
        )
      ) : !info?.error ? <p className="text-muted-foreground">Not checked yet.</p> : null}
    </div>
  );
}
