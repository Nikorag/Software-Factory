import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PRESETS, type RouteCfg } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * The independent reviewer: any OpenAI-compatible endpoint (base URL, model, optional NAME of the environment variable that holds the key),
 * or nothing, which skips the step. A route that still points at Claude is shown with the usual picker.
 */
export function ReviewerPicker({ value, onChange, label }: { value: RouteCfg | null | undefined; onChange: (v: RouteCfg | null) => void; label: string }) {
  if (!value) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Not set: the independent review is skipped.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange({ provider: "local", model: "", baseUrl: "" })}>Set a reviewer</Button>
      </div>
    );
  }
  const clear = <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)}>Clear (skip this step)</Button>;
  if (value.provider === "anthropic") {
    return <div className="flex flex-wrap items-center gap-2"><ModelPicker label={label} allowLocal={false} value={value} onChange={onChange} />
      <Button type="button" size="sm" variant="outline" onClick={() => onChange({ provider: "local", model: "", baseUrl: "" })}>Use an endpoint</Button>{clear}</div>;
  }
  const set = (patch: Partial<RouteCfg>) => { const n = { ...value, ...patch }; if (!n.apiKeyEnv) delete n.apiKeyEnv; onChange(n); };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={`${label} base URL`} className="h-8 w-64 font-mono text-xs" value={value.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      <Input aria-label={`${label} model`} className="h-8 w-44 font-mono text-xs" value={value.model} onChange={(e) => set({ model: e.target.value })} placeholder="model id" />
      <Input aria-label={`${label} key variable`} className="h-8 w-44 font-mono text-xs" value={value.apiKeyEnv ?? ""} onChange={(e) => set({ apiKeyEnv: e.target.value })} placeholder="API key env var (optional)" />
      {clear}
    </div>
  );
}

/** Provider + model. Claude Code takes an alias (default, haiku, sonnet, opus: tracks the latest) or a full model id to pin one. */
export function ModelPicker({ value, onChange, allowLocal, label }: { value: RouteCfg; onChange: (v: RouteCfg) => void; allowLocal: boolean; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {allowLocal ? (
        <Select value={value.provider} onValueChange={(v) => onChange({ provider: v as RouteCfg["provider"], model: v === "local" ? "" : "haiku" })}>
          <SelectTrigger className="w-32" aria-label={`${label} provider`}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="anthropic">Claude</SelectItem><SelectItem value="local">Local model</SelectItem></SelectContent>
        </Select>
      ) : <span className="w-32 text-sm text-muted-foreground">Claude</span>}
      {value.provider === "anthropic" ? (
        <div className="flex gap-1" role="group" aria-label={`${label} model presets`}>
          {PRESETS.map((m) => <Button key={m} type="button" size="sm" variant={value.model === m ? "default" : "outline"} aria-pressed={value.model === m} className={cn("h-8 px-2.5")} onClick={() => onChange({ ...value, model: m })}>{m}</Button>)}
        </div>
      ) : null}
      <Input aria-label={`${label} model`} className="h-8 w-52 font-mono text-xs" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder={value.provider === "local" ? "model id from your server" : "or a full id, e.g. claude-haiku-5-5"} />
    </div>
  );
}
