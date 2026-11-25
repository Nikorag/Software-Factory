import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, send } from "@/lib/api";
import type { BitbucketCredential } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

const KIND_LABEL = { "access-token": "Access token (repository, project or workspace)", "api-token": "API token (your Atlassian account)" } as const;

/** Bitbucket Cloud credentials. A project picks one by name, so a token scoped to one repository can serve only that project. Tokens go to the keychain. */
export function BitbucketSetup() {
  const { data, reload } = usePoll(() => api<{ credentials: BitbucketCredential[] }>("/api/bitbucket/credentials"), 15000);
  const [name, setName] = useState("default"), [kind, setKind] = useState<"access-token" | "api-token">("access-token"), [email, setEmail] = useState(""), [token, setToken] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const edit = (c: BitbucketCredential) => { setName(c.name); setKind(c.kind); setEmail(c.email ?? ""); setToken(""); setMsg(null); };
  const save = async () => {
    const r = await send("PUT", `/api/bitbucket/credentials/${encodeURIComponent(name)}`, { kind, email: kind === "api-token" ? email : undefined, token: token || undefined });
    if (r.ok) { setToken(""); setMsg({ ok: true, text: `Saved "${name}". The token is in your keychain.` }); void reload(); } else setMsg({ ok: false, text: r.error });
  };
  const remove = async (n: string) => { const r = await send("DELETE", `/api/bitbucket/credentials/${encodeURIComponent(n)}`); setMsg(r.ok ? { ok: true, text: `Removed "${n}".` } : { ok: false, text: r.error }); void reload(); };

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">Used by projects hosted on Bitbucket Cloud (each project chooses GitHub or Bitbucket in its own settings). A token, not OAuth: nothing to register and no callback. Prefer a <b>repository access token</b>: it can only reach that one repository.</p>
      <div className="grid gap-2">
        {(data?.credentials ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No credentials yet.</p> : null}
        {(data?.credentials ?? []).map((c) => (
          <div key={c.name} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
            <KeyRound className="size-4 text-muted-foreground" /><b>{c.name}</b>
            <Badge variant="outline">{c.kind === "api-token" ? "API token" : "access token"}</Badge>
            {c.email ? <span className="text-muted-foreground">{c.email}</span> : null}
            <span className={c.hasToken ? "text-ok" : "text-loop"}>{c.hasToken ? "token saved" : "no token"}</span>
            <span className="text-xs text-muted-foreground">{c.usedBy.length ? `used by ${c.usedBy.join(", ")}` : "not used yet"}</span>
            <span className="flex-1" />
            <Button size="sm" variant="outline" onClick={() => edit(c)}>Edit</Button>
            <Button size="sm" variant="outline" aria-label={`remove ${c.name}`} onClick={() => void remove(c.name)}><Trash2 /></Button>
          </div>
        ))}
      </div>
      <div className="grid gap-3 rounded-md border p-3">
        <div className="text-sm font-medium">Add or update a credential</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="bb-name">Name</Label><Input id="bb-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="default" /></div>
          <div className="grid gap-1.5"><Label>Kind of token</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}><SelectTrigger aria-label="kind of token"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent></Select></div>
        </div>
        {kind === "api-token" ? <div className="grid gap-1.5"><Label htmlFor="bb-email">Atlassian account email</Label><Input id="bb-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div> : null}
        <div className="grid gap-1.5"><Label htmlFor="bb-token">Token {data?.credentials.some((c) => c.name === name && c.hasToken) ? "(saved: paste to replace)" : ""}</Label><Input id="bb-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></div>
        <ul className="grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
          <li><b>Access token:</b> in the repository → Repository settings → Security → Access tokens. Give it <i>Repositories: Write</i> and <i>Pull requests: Write</i>. (Project and workspace tokens work too, on Premium.) It expires at most a year after creation.</li>
          <li><b>API token:</b> Atlassian account → Security → API tokens → Create with scopes → Bitbucket. Needs read and write for repositories and for pull requests. Replaces app passwords, which Atlassian has shut down.</li>
        </ul>
        {msg ? <Alert variant={msg.ok ? "default" : "destructive"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
        <div><Button disabled={!name || (kind === "api-token" && !email) || (!token && !data?.credentials.some((c) => c.name === name && c.hasToken))} onClick={() => void save()}>Save credential</Button></div>
      </div>
    </div>
  );
}
