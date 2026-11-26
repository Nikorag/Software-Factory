import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, send } from "@/lib/api";
import { usePoll } from "@/hooks/usePoll";

interface HubStatus { enabled: boolean; remoteAccess: boolean; url: string; keyPresent: boolean; keyRejected: boolean; lastSuccessAt: string | null; lastError: string | null; pendingRetryAt: string | null }

/** Attach this factory to a central Software Factory Hub. The API key is sent once, stored in the keychain by the server, and never shown again. */
export function HubSetup() {
  const { data: s, reload } = usePoll(() => api<HubStatus>("/api/hub"), 15000);
  const [url, setUrl] = useState(""), [key, setKey] = useState(""), [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => ReturnType<typeof send>, done: string) => {
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, text: done }); setKey(""); void reload(); } else setMsg({ ok: false, text: r.error });
  };
  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="grid gap-3 text-sm">
      {s.enabled ? (
        <>
          <div className="grid gap-1">
            <div>Connected to <span className="font-mono text-xs">{s.url}</span></div>
            <div className="text-muted-foreground">{s.keyRejected ? "The hub rejected the key: reconnect with a new one." : !s.keyPresent ? "No API key found: reconnect." : s.lastError ? `Last report failed: ${s.lastError}` : s.lastSuccessAt ? `Last reported ${new Date(s.lastSuccessAt).toLocaleString()}` : "Connected, waiting for the first report…"}</div>
          </div>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={s.remoteAccess} disabled={busy} onChange={(e) => void run(() => send("PUT", "/api/hub/remote-access", { on: e.target.checked }), e.target.checked ? "The hub's dashboard can now operate this factory." : "Remote dashboard access is off.")} />
            <span>Let the hub's web dashboard operate this factory<span className="block text-xs text-muted-foreground">Off by default. Secrets, shutdown, updates and project settings stay blocked remotely either way.</span></span></label>
          <div><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => send("POST", "/api/hub/disconnect"), "Disconnected. The API key was removed.")}>Disconnect</Button></div>
        </>
      ) : (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void run(() => send("POST", "/api/hub/connect", { url: url.trim(), key: key.trim(), remoteAccess: remote }), "Connected. This factory is now reporting to the hub."); }}>
          <p className="text-muted-foreground">Nothing leaves this machine until you connect. Create an API key on your hub's web page, then paste it here.</p>
          <div className="grid gap-1.5"><Label htmlFor="hub-url">Hub address</Label><Input id="hub-url" className="max-w-md" placeholder="https://factory.example.com" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="hub-key">API key</Label><Input id="hub-key" type="password" autoComplete="off" className="max-w-md font-mono" placeholder="sfh_…" value={key} onChange={(e) => setKey(e.target.value)} /></div>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={remote} onChange={(e) => setRemote(e.target.checked)} /><span>Also let the hub's dashboard operate this factory <span className="text-xs text-muted-foreground">(off by default)</span></span></label>
          <div><Button type="submit" size="sm" disabled={busy || !url.trim() || !key.trim()}>{busy ? "Connecting…" : "Connect"}</Button></div>
        </form>
      )}
      {msg && <p className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </div>
  );
}
