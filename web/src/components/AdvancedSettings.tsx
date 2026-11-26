import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, send } from "@/lib/api";

interface Adv { agentAccess: "restricted" | "unrestricted"; dryRun: boolean; sandboxRequired: boolean; commandTimeoutSeconds: number; pollIntervalSeconds: number; logRetentionDays: number; logLevel: string; protectedPaths: string[] }

/** The remaining factory.yaml keys. Written to the file; they take effect when the factory restarts. */
export function AdvancedSettings() {
  const [a, setA] = useState<Adv | null>(null), [paths, setPaths] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { void api<Adv>("/api/settings/advanced").then((v) => { setA(v); setPaths(v.protectedPaths.join("\n")); }).catch((e: Error) => setMsg({ ok: false, text: e.message })); }, []);
  if (!a) return <p className="text-sm text-muted-foreground">{msg?.text ?? "Loading…"}</p>;
  const set = <K extends keyof Adv>(k: K, v: Adv[K]) => setA({ ...a, [k]: v });
  const num = (k: "commandTimeoutSeconds" | "pollIntervalSeconds" | "logRetentionDays", label: string, hint: string) => (
    <div className="grid gap-1.5"><Label htmlFor={`adv-${k}`}>{label}</Label><Input id={`adv-${k}`} type="number" className="w-32" value={a[k]} onChange={(e) => set(k, Number(e.target.value))} /><span className="text-xs text-muted-foreground">{hint}</span></div>
  );
  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await send("PUT", "/api/settings/advanced", { ...a, protectedPaths: paths.split("\n").map((l) => l.trim()).filter(Boolean) });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "Saved to factory.yaml. Restart the factory for it to take effect." } : { ok: false, text: r.error });
  };
  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-1.5"><Label>Agent access (all projects)</Label>
        <Select value={a.agentAccess} onValueChange={(v) => set("agentAccess", v as Adv["agentAccess"])}><SelectTrigger aria-label="default agent access" className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="restricted">restricted: git and the project checks only</SelectItem><SelectItem value="unrestricted">unrestricted: Claude Code auto mode, any command</SelectItem></SelectContent></Select>
        <span className="text-xs text-muted-foreground">A project can override this in its own settings.</span></div>
      <div className="grid gap-3 sm:grid-cols-3">
        {num("commandTimeoutSeconds", "Command timeout (s)", "Per build/test/lint command.")}
        {num("pollIntervalSeconds", "Poll interval (s)", "How often tickets are discovered.")}
        {num("logRetentionDays", "Log retention (days)", "0 keeps logs forever.")}
      </div>
      <div className="grid gap-1.5"><Label>Log level</Label>
        <Select value={a.logLevel} onValueChange={(v) => set("logLevel", v)}><SelectTrigger aria-label="log level" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{["trace", "debug", "info", "warn", "error"].map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent></Select></div>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={a.dryRun} onChange={(e) => set("dryRun", e.target.checked)} /><span>Dry run<span className="block text-xs text-muted-foreground">Discover and plan, but never change repositories or the tracker.</span></span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={a.sandboxRequired} onChange={(e) => set("sandboxRequired", e.target.checked)} /><span>Require the command sandbox<span className="block text-xs text-muted-foreground">Off lets build/test commands run unconfined if sandbox-exec is missing. Not recommended.</span></span></label>
      <div className="grid gap-1.5"><Label htmlFor="adv-paths">Protected paths</Label>
        <textarea id="adv-paths" rows={6} className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={paths} onChange={(e) => setPaths(e.target.value)} />
        <span className="text-xs text-muted-foreground">One glob per line. Agents can never write these, and a change to one fails the run. Removing entries weakens that protection.</span></div>
      <div className="flex items-center gap-3"><Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
        {msg && <span className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} role={msg.ok ? "status" : "alert"}>{msg.text}</span>}</div>
    </div>
  );
}
