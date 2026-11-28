import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePlugins } from "@/hooks/usePlugins";
import { send } from "@/lib/api";
import { fieldsFor, settingsFrom, type PluginInfo, type ProbeResult, type SettingField } from "@/lib/tasks";

const CAPS: [keyof PluginInfo["capabilities"], string][] = [["tools", "file & shell tools"], ["writesWorktree", "writes the worktree"], ["structuredOutput", "structured output"], ["streaming", "streaming"], ["listsModels", "lists models"], ["readOnly", "read-only"], ["usesApiKey", "uses an API key"]];
const FIELD_LABEL: Record<SettingField, { label: string; placeholder: string }> = {
  baseUrl: { label: "Base URL", placeholder: "http://127.0.0.1:1234/v1" },
  apiKeyEnv: { label: "API key variable", placeholder: "NAME of the environment variable (never the key)" },
};

/** Installed provider plugins, their capabilities and state, and the named instances that workflow steps pick from. */
export function PluginsSettings() {
  const { plugins, error, reload } = usePlugins();
  const [draft, setDraft] = useState<{ id: string; plugin: string; values: Partial<Record<SettingField, string>> }>({ id: "", plugin: "openai", values: {} });
  const [results, setResults] = useState<Record<string, ProbeResult | string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  if (!plugins) return <p className="text-sm text-muted-foreground">{error ? `Could not load plugins: ${error}` : "Loading plugins…"}</p>;

  const info = (id: string) => plugins.plugins.find((p) => p.id === id);
  const customs = () => Object.fromEntries(plugins.instances.filter((i) => !i.builtin).map((i) => [i.id, { plugin: i.plugin, settings: i.settings }]));
  const save = async (instances: Record<string, unknown>) => { setMsg(null); const r = await send("PUT", "/api/plugins/instances", { instances }); if (r.ok) await reload(); else setMsg(r.error); return r.ok; };
  const validate = async (key: string, body: unknown) => {
    const r = await send<ProbeResult>("POST", "/api/plugins/validate", body);
    setResults((o) => ({ ...o, [key]: r.ok ? r.data : r.error }));
  };
  const draftPlugin = info(draft.plugin);
  const draftSettings = settingsFrom(draftPlugin, draft.values);
  const result = (key: string) => { const r = results[key]; return r === undefined ? null : typeof r === "string" ? <p role="alert" className="text-xs text-destructive">{r}</p> : <p role="status" className={`text-xs ${r.ok ? "text-muted-foreground" : "text-destructive"}`}>{r.ok ? "OK: " : "Problem: "}{r.detail}{r.models?.length ? ` (${r.models.slice(0, 8).join(", ")}${r.models.length > 8 ? ", …" : ""})` : ""}</p>; };

  return (
    <div className="grid gap-4">
      <Card><CardHeader><CardTitle className="text-sm">Plugins</CardTitle><CardDescription>Providers the workflow can use. What each can do decides where it is offered: steps that read and write the repository need file and shell tools.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          {plugins.plugins.map((p) => (
            <div key={p.id} className="grid gap-1 border-b pb-3 last:border-0 last:pb-0" aria-label={`Plugin ${p.name}`}>
              <div className="flex flex-wrap items-baseline gap-x-3"><b className="text-sm">{p.name}</b><span className="font-mono text-xs text-muted-foreground">{p.id} {p.version}</span>
                <span className="text-xs text-muted-foreground">{p.capabilities.kind === "cli" ? "runs a local CLI" : "calls an API"}{p.builtin ? " · built in" : ""}</span>
                <span className={`text-xs ${p.state === "available" ? "text-muted-foreground" : "text-destructive"}`}>{p.state}</span></div>
              {p.description ? <p className="text-xs text-muted-foreground">{p.description}</p> : null}
              <p className="text-xs">{CAPS.filter(([k]) => p.capabilities[k]).map(([, l]) => l).join(" · ") || "no declared capabilities"}</p>
              {p.reason ? <p role="alert" className="text-xs text-destructive">{p.reason}</p> : null}
            </div>
          ))}
        </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-sm">Plugin instances</CardTitle><CardDescription>A provider configured once under a name; workflow steps and project overrides pick the name. Secrets are never stored: a key is only ever the NAME of an environment variable.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          {plugins.instances.map((i) => {
            const p = info(i.plugin);
            return (
              <div key={i.id} className="grid gap-1 border-b pb-3 last:border-0 last:pb-0" aria-label={`Instance ${i.id}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><b className="font-mono text-sm">{i.id}</b><span className="text-xs text-muted-foreground">{p?.name ?? i.plugin}{i.builtin ? " · default" : ""}</span>
                  <span className={`text-xs ${i.valid ? "text-muted-foreground" : "text-destructive"}`}>{i.valid ? "settings valid" : "misconfigured"}</span>
                  <span className="text-xs text-muted-foreground">{i.usedBy.length ? `used by ${i.usedBy.join(", ")}` : "not used by any step"}</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => void validate(i.id, { instance: i.id })}>Validate</Button>
                  {!i.builtin ? <Button type="button" size="sm" variant="outline" disabled={i.usedBy.length > 0} title={i.usedBy.length ? "Still used by a workflow step" : undefined} onClick={() => { const rest = customs(); delete rest[i.id]; void save(rest); }}>Remove</Button> : null}</div>
                {Object.keys(i.settings).length ? <p className="font-mono text-xs text-muted-foreground">{Object.entries(i.settings).map(([k, v]) => `${k}=${String(v)}`).join("  ")}</p> : null}
                {i.error ? <p role="alert" className="text-xs text-destructive">{i.error}</p> : null}
                {result(i.id)}
              </div>
            );
          })}
        </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-sm">Add an instance</CardTitle><CardDescription>Only the settings the chosen plugin supports are shown. Validate checks the settings and, where the plugin can, that the server answers. It never sends a prompt.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label htmlFor="pl-id">Instance name</Label><Input id="pl-id" className="w-48 font-mono text-xs" value={draft.id} placeholder="e.g. lm-studio" onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>Plugin</Label>
              <Select value={draft.plugin} onValueChange={(v) => setDraft({ ...draft, plugin: v, values: {} })}>
                <SelectTrigger className="w-56" aria-label="Plugin"><SelectValue /></SelectTrigger>
                <SelectContent>{plugins.plugins.filter((p) => p.state === "available").map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select></div>
            {fieldsFor(draftPlugin).map((f) => (
              <div key={f} className="grid gap-1.5"><Label htmlFor={`pl-${f}`}>{FIELD_LABEL[f].label}</Label>
                <Input id={`pl-${f}`} className="w-64 font-mono text-xs" value={draft.values[f] ?? ""} placeholder={f === "baseUrl" && draft.plugin === "openai" ? "https://api.openai.com/v1" : f === "apiKeyEnv" && draft.plugin === "openai" ? "OPENAI_API_KEY" : FIELD_LABEL[f].placeholder} onChange={(e) => setDraft({ ...draft, values: { ...draft.values, [f]: e.target.value } })} /></div>
            ))}
            <Button type="button" variant="outline" onClick={() => void validate("draft", { plugin: draft.plugin, settings: draftSettings })}>Validate</Button>
            <Button type="button" disabled={!draft.id.trim()} onClick={async () => { if (await save({ ...customs(), [draft.id.trim()]: { plugin: draft.plugin, settings: draftSettings } })) setDraft({ ...draft, id: "", values: {} }); }}>Add instance</Button>
          </div>
          {result("draft")}
          {msg ? <p role="alert" className="text-sm text-destructive">{msg}</p> : null}
        </CardContent></Card>
    </div>
  );
}
