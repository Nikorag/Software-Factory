import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ENDPOINT_INSTANCE, FALLBACK_PLUGINS, instanceOfRoute, instanceOptions, pluginOfInstance, routeFor, type PluginsView, type RouteCfg } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * The independent reviewer: any plugin instance that can answer a prompt (an OpenAI-style server, the OpenAI API, Claude Code...), or nothing,
 * which skips the step. A reviewer written the old way with its own endpoint keeps its base URL, model and key-variable fields.
 */
export function ReviewerPicker({ value, onChange, label, plugins }: { value: RouteCfg | null | undefined; onChange: (v: RouteCfg | null) => void; label: string; plugins?: PluginsView | null }) {
  if (!value) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Not set: the independent review is skipped.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(routeFor("local", ""))}>Set a reviewer</Button>
      </div>
    );
  }
  const clear = <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)}>Clear (skip this step)</Button>;
  if (instanceOfRoute(value) !== ENDPOINT_INSTANCE) {
    return <div className="flex flex-wrap items-center gap-2"><ModelPicker label={label} needsTools={false} plugins={plugins} value={value} onChange={onChange} />{clear}</div>;
  }
  const set = (patch: Partial<RouteCfg>) => { const n = { ...value, ...patch }; if (!n.apiKeyEnv) delete n.apiKeyEnv; onChange(n); };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={`${label} base URL`} className="h-8 w-64 font-mono text-xs" value={value.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      <Input aria-label={`${label} model`} className="h-8 w-44 font-mono text-xs" value={value.model} onChange={(e) => set({ model: e.target.value })} placeholder="model id" />
      <Input aria-label={`${label} key variable`} className="h-8 w-44 font-mono text-xs" value={value.apiKeyEnv ?? ""} onChange={(e) => set({ apiKeyEnv: e.target.value })} placeholder="API key env var (optional)" />
      <Button type="button" size="sm" variant="outline" onClick={() => onChange(routeFor("local", value.model))}>Use a plugin instead</Button>
      {clear}
    </div>
  );
}

/**
 * Plugin instance + model. Only instances whose plugin can do the step are offered, and only the fields that plugin supports are shown:
 * one-click model presets when it declares some (Claude Code: default, haiku, sonnet, opus), otherwise a model id from its server.
 * Endpoints, base URLs and key variables belong to the instance and are set once on the Plugins tab, not per step.
 */
export function ModelPicker({ value, onChange, needsTools, label, plugins }: { value: RouteCfg; onChange: (v: RouteCfg) => void; needsTools: boolean; label: string; plugins?: PluginsView | null }) {
  const view = plugins ?? FALLBACK_PLUGINS;
  const current = instanceOfRoute(value);
  const options = instanceOptions(view, needsTools);
  const inst = view.instances.find((i) => i.id === current);
  const plugin = pluginOfInstance(view, current);
  const presets = plugin?.modelPresets ?? [];
  const known = options.some((o) => o.id === current);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.length > 1 || !known ? (
        <Select value={current} onValueChange={(id) => onChange(routeFor(id, pluginOfInstance(view, id)?.modelPresets[0] ?? ""))}>
          <SelectTrigger className="w-44" aria-label={`${label} plugin`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.id === o.plugin ? (view.plugins.find((p) => p.id === o.plugin)?.name ?? o.id) : `${o.id} (${view.plugins.find((p) => p.id === o.plugin)?.name ?? o.plugin})`}</SelectItem>)}
            {!known ? <SelectItem value={current}>{current} (not available here)</SelectItem> : null}
          </SelectContent>
        </Select>
      ) : <span className="w-44 text-sm text-muted-foreground">{plugin?.name ?? current}</span>}
      {presets.length ? (
        <div className="flex gap-1" role="group" aria-label={`${label} model presets`}>
          {presets.map((m) => <Button key={m} type="button" size="sm" variant={value.model === m ? "default" : "outline"} aria-pressed={value.model === m} className={cn("h-8 px-2.5")} onClick={() => onChange({ ...value, model: m })}>{m}</Button>)}
        </div>
      ) : null}
      <Input aria-label={`${label} model`} className="h-8 w-52 font-mono text-xs" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder={presets.length ? "or a full id, e.g. claude-haiku-5-5" : "model id from the server"} />
      {inst && !inst.valid ? <span role="alert" className="basis-full text-xs text-destructive">{inst.error ?? "This plugin instance is misconfigured."}</span> : null}
      {plugin && plugin.state !== "available" ? <span role="alert" className="basis-full text-xs text-destructive">{plugin.reason}</span> : null}
    </div>
  );
}
