import { useState } from "react";
import { Plug, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, send } from "@/lib/api";
import type { McpServerView } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

/** MCP servers agents may use. Secret values go to the keychain; the list only ever shows whether each is set. Projects choose theirs in their own settings. */
export function McpSetup() {
  const { data, reload } = usePoll(() => api<{ servers: McpServerView[]; defaultServers: string[] }>("/api/mcp/servers"), 15000);
  const [name, setName] = useState(""), [type, setType] = useState<"stdio" | "http" | "sse">("stdio"), [command, setCommand] = useState(""), [args, setArgs] = useState(""), [url, setUrl] = useState(""), [env, setEnv] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const envNames = env.split(",").map((s) => s.trim()).filter(Boolean);
  const done = (r: { ok: boolean; error?: string }, text: string) => { setMsg(r.ok ? { ok: true, text } : { ok: false, text: r.error ?? "failed" }); void reload(); };

  const save = async () => {
    const body = { type, command: type === "stdio" ? command : undefined, args: type === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined, url: type === "stdio" ? undefined : url, env: envNames, secrets: Object.fromEntries(Object.entries(secrets).filter(([k, v]) => v && envNames.includes(k))) };
    const r = await send("PUT", `/api/mcp/servers/${encodeURIComponent(name)}`, body);
    if (r.ok) setSecrets({});
    done(r, `Saved "${name}". Secret values are in your keychain.`);
  };
  const edit = (s: McpServerView) => { setName(s.name); setType(s.type); setCommand(s.command ?? ""); setArgs(s.args.join(" ")); setUrl(s.url ?? ""); setEnv(s.env.join(", ")); setSecrets({}); setMsg(null); };
  const test = async (n: string) => {
    const r = await send("POST", `/api/mcp/servers/${encodeURIComponent(n)}/test`);
    setMsg(r.ok ? { ok: true, text: `"${n}" looks ready (secrets set, command found). It was not started.` } : { ok: false, text: r.error });
  };
  const toggleDefault = async (s: McpServerView) => done(await send("PUT", "/api/mcp/default", { servers: s.isDefault ? (data?.defaultServers ?? []).filter((x) => x !== s.name) : [...(data?.defaultServers ?? []), s.name] }), `Updated the default servers.`);

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">Nothing is available to agents unless it is listed here. Servers marked default go to every project; a project can choose its own list in its settings.</p>
      <div className="grid gap-2">
        {(data?.servers ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No MCP servers yet.</p> : null}
        {(data?.servers ?? []).map((s) => (
          <div key={s.name} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
            <Plug className="size-4 text-muted-foreground" /><b>{s.name}</b><Badge variant="outline">{s.type}</Badge>
            {s.secrets.map((x) => <span key={x.name} className={x.set ? "text-ok" : "text-loop"}>{x.name}: {x.set ? "set" : "not set"}</span>)}
            <span className="text-xs text-muted-foreground">{s.usedBy.length ? `selected by ${s.usedBy.join(", ")}` : ""}</span>
            <span className="flex-1" />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={s.isDefault} onChange={() => void toggleDefault(s)} />default</label>
            <Button size="sm" variant="outline" onClick={() => void test(s.name)}>Test</Button>
            <Button size="sm" variant="outline" onClick={() => edit(s)}>Edit</Button>
            <Button size="sm" variant="outline" aria-label={`remove ${s.name}`} onClick={async () => done(await send("DELETE", `/api/mcp/servers/${encodeURIComponent(s.name)}`), `Removed "${s.name}".`)}><Trash2 /></Button>
          </div>
        ))}
      </div>
      <div className="grid gap-3 rounded-md border p-3">
        <div className="text-sm font-medium">Add or update a server</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="mcp-name">Server name</Label><Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9-]/g, "-"))} placeholder="github" /></div>
          <div className="grid gap-1.5"><Label htmlFor="mcp-type">Type</Label>
            <select id="mcp-type" className="h-9 rounded-md border bg-transparent px-2 text-sm" value={type} onChange={(e) => setType(e.target.value as typeof type)}><option value="stdio">stdio (a command)</option><option value="http">http</option><option value="sse">sse</option></select></div>
        </div>
        {type === "stdio"
          ? <div className="grid gap-2 sm:grid-cols-2"><div className="grid gap-1.5"><Label htmlFor="mcp-cmd">Command</Label><Input id="mcp-cmd" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></div><div className="grid gap-1.5"><Label htmlFor="mcp-args">Arguments</Label><Input id="mcp-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y some-mcp-server" /></div></div>
          : <div className="grid gap-1.5"><Label htmlFor="mcp-url">URL</Label><Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></div>}
        <div className="grid gap-1.5"><Label htmlFor="mcp-env">Secret variable names (comma separated)</Label><Input id="mcp-env" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="GITHUB_TOKEN" /></div>
        {envNames.map((k) => <div key={k} className="grid gap-1.5"><Label htmlFor={`mcp-s-${k}`}>{k} (paste to set or replace)</Label><Input id={`mcp-s-${k}`} type="password" autoComplete="off" value={secrets[k] ?? ""} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} /></div>)}
        {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
        <div><Button disabled={!name || (type === "stdio" ? !command : !url)} onClick={() => void save()}>Save server</Button></div>
      </div>
    </div>
  );
}
