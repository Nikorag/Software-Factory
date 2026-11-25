import { useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, send } from "@/lib/api";
import type { ProfileInfo } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

/** Profiles are separate factories (own projects, Linear, GitHub account, data) that run side by side. */
export function ProfilesSettings() {
  const { data, reload } = usePoll(() => api<{ current: string; profiles: ProfileInfo[] }>("/api/profiles"), 5000);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const add = async () => {
    const r = await send<{ profile?: { name: string; url: string }; warning?: string }>("POST", "/api/profiles", { name: name.trim().toLowerCase() });
    if (r.ok) { setName(""); setMsg({ ok: !r.data.warning, text: r.data.warning ?? `Created "${r.data.profile?.name ?? name}" and started it. Switch to it from the profile menu to set up its Linear key and projects.` }); void reload(); } else setMsg({ ok: false, text: r.error });
  };
  const remove = async (n: string) => { const r = await send("DELETE", `/api/profiles/${encodeURIComponent(n)}`); setMsg(r.ok ? { ok: true, text: `Removed "${n}". Its data is still on disk.` } : { ok: false, text: r.error }); void reload(); };
  return (
    <div className="grid gap-4">
      <Card><CardHeader><CardTitle className="text-sm">Profiles</CardTitle><CardDescription>Each profile is its own factory with its own projects, Linear workspace, GitHub account, data and port. They run at the same time and never share anything.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {(data?.profiles ?? []).map((p) => (
            <div key={p.name} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
              <b>{p.name}</b>
              {p.current ? <Badge variant="secondary">this one</Badge> : null}
              <span className={p.running ? "text-ok" : "text-muted-foreground"}>{p.running ? "● running" : "○ stopped"}</span>
              <span className="font-mono text-xs text-muted-foreground">port {p.port}</span>
              <span className="flex-1" />
              {!p.current && p.running ? <Button size="sm" variant="outline" asChild><a href={p.url}><ExternalLink />Switch</a></Button> : null}
              {!p.current && p.name !== "default" ? (
                <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="outline" aria-label={`remove ${p.name}`}><Trash2 /></Button></AlertDialogTrigger>
                  <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove profile {p.name}?</AlertDialogTitle><AlertDialogDescription>It disappears from the list. Its data stays on disk in case you want it back. A running profile must be shut down first.</AlertDialogDescription></AlertDialogHeader>
                    <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void remove(p.name)}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
              ) : null}
            </div>
          ))}
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Add a profile</CardTitle></CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="pf-new">Name</Label>
          <div className="flex gap-2"><Input id="pf-new" value={name} onChange={(e) => setName(e.target.value)} placeholder="work" className="max-w-xs" /><Button disabled={!name.trim()} onClick={() => void add()}><Plus />Create profile</Button></div>
          <p className="text-xs text-muted-foreground">Lowercase letters, numbers and hyphens. The new profile starts empty: it asks for its own Linear key, GitHub account and projects.</p>
          {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
        </CardContent></Card>
    </div>
  );
}
