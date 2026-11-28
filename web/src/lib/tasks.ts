export type TaskId = "classification" | "specification" | "implementation" | "independent_review" | "final_review" | "prompt_generation";
/**
 * A route names a plugin INSTANCE (`plugin`), configured once on the Plugins tab. Files written before plugins name a `provider`
 * instead (anthropic -> claude-code, local -> the shared local server); both shapes are read and sent back as they were until edited.
 * `baseUrl` and `apiKeyEnv` (the NAME of an environment variable, never the key) only appear on an older reviewer's own endpoint.
 */
export interface RouteCfg { plugin?: string; provider?: "anthropic" | "local"; model: string; baseUrl?: string; apiKeyEnv?: string }
/** `independent_review` null or absent = no independent reviewer: the step is skipped. */
export type Routes = Record<Exclude<TaskId, "prompt_generation" | "independent_review">, RouteCfg> & { prompt_generation?: RouteCfg; independent_review?: RouteCfg | null };
/** The route a profile has when it never set one: Haiku writes the implementer's prompt. */
export const DEFAULT_PROMPT_ROUTE: RouteCfg = { provider: "anthropic", model: "haiku" };
export type PickupMode = "automatic" | "manual";
export type PlanningMode = "haiku_prompt" | "speckit";
export interface GlobalSettings { planningMode?: PlanningMode; maxImplementationPasses?: number; pickupMode?: PickupMode; githubAccount?: string; skills?: { name: string; path: string }[]; maxConcurrentJobs: number; maxRemediationAttempts: number; routes: Routes }

/** The model choices the factory makes, and the workflow steps each one drives (as drawn on the job's flow chart). `tools`: the step needs a plugin with file and shell tools. */
export const TASKS: { id: TaskId; label: string; steps: string; tools: boolean }[] = [
  { id: "classification", label: "Triage", steps: "Ticket triage before analysis; condensing long check logs", tools: false },
  { id: "prompt_generation", label: "Prompt writer", steps: "Haiku-prompt mode: reads the repository and writes the implementer's prompt (Requirements)", tools: true },
  { id: "specification", label: "Specification", steps: "Spec Kit mode: Requirements, Generate spec, Spec validation, Fix spec, implementation convergence checks", tools: true },
  { id: "implementation", label: "Implementation", steps: "Implement, and Fix findings after a review or failed check", tools: true },
  { id: "independent_review", label: "Independent review", steps: "Spec review and the independent code review, by any plugin (should differ from the model that wrote the work). Not set = skipped", tools: false },
  { id: "final_review", label: "Claude review", steps: "Security review, Claude review, Final validation", tools: false },
];
export const PRESETS = ["default", "haiku", "sonnet", "opus"] as const;

// ---- plugins (GET /api/plugins) ----
export interface PluginCapabilities { kind: "cli" | "api"; tools: boolean; writesWorktree: boolean; structuredOutput: boolean; streaming: boolean; listsModels: boolean; readOnly: boolean; usesApiKey: boolean }
export interface PluginInfo {
  id: string; name: string; description?: string; version: string; engineApi: { min: number; max: number }; capabilities: PluginCapabilities;
  modelPresets: string[]; state: "available" | "incompatible" | "misconfigured"; reason?: string; builtin: boolean;
}
export interface PluginInstanceView { id: string; plugin: string; settings: Record<string, unknown>; builtin: boolean; valid: boolean; error?: string; usedBy: string[] }
export interface PluginsView { plugins: PluginInfo[]; instances: PluginInstanceView[] }

/** What to offer before /api/plugins answers (or when it cannot): the two instances every profile has. */
export const FALLBACK_PLUGINS: PluginsView = {
  plugins: [
    { id: "claude-code", name: "Claude Code", version: "", engineApi: { min: 1, max: 1 }, capabilities: { kind: "cli", tools: true, writesWorktree: true, structuredOutput: true, streaming: false, listsModels: false, readOnly: true, usesApiKey: false }, modelPresets: [...PRESETS], state: "available", builtin: true },
    { id: "openai-compatible", name: "OpenAI-compatible server", version: "", engineApi: { min: 1, max: 1 }, capabilities: { kind: "api", tools: false, writesWorktree: false, structuredOutput: true, streaming: false, listsModels: true, readOnly: true, usesApiKey: true }, modelPresets: [], state: "available", builtin: true },
  ],
  instances: [
    { id: "claude-code", plugin: "claude-code", settings: {}, builtin: true, valid: true, usedBy: [] },
    { id: "local", plugin: "openai-compatible", settings: {}, builtin: true, valid: true, usedBy: [] },
  ],
};

/** The instance a route means: its `plugin`, or what a legacy `provider` always meant. A legacy local route with its own endpoint is not a named instance. */
export const ENDPOINT_INSTANCE = "(custom endpoint)";
export const instanceOfRoute = (r: RouteCfg): string => r.plugin ?? (r.provider === "local" ? (r.baseUrl ? ENDPOINT_INSTANCE : "local") : "claude-code");
export const routeFor = (instance: string, model: string): RouteCfg => ({ plugin: instance, model });

/** The instances a step may use: available plugins whose capabilities fit (a step that reads and writes the repository needs tools). */
export function instanceOptions(view: PluginsView, needsTools: boolean): PluginInstanceView[] {
  return view.instances.filter((i) => {
    const p = view.plugins.find((x) => x.id === i.plugin);
    return !!p && p.state === "available" && (!needsTools || p.capabilities.tools);
  });
}
/** The settings fields worth showing for a plugin, from what it declares it can do: an API endpoint has a base URL, a keyed one has a key variable. A CLI plugin has none. */
export type SettingField = "baseUrl" | "apiKeyEnv";
export const fieldsFor = (p: PluginInfo | undefined): SettingField[] => [...(p?.capabilities.kind === "api" ? ["baseUrl" as const] : []), ...(p?.capabilities.usesApiKey ? ["apiKeyEnv" as const] : [])];
/** Settings to send for the fields shown (blank ones are left out, so the plugin's defaults apply). Only the NAME of a key variable is ever sent. */
export const settingsFrom = (p: PluginInfo | undefined, values: Partial<Record<SettingField, string>>): Record<string, string> =>
  Object.fromEntries(fieldsFor(p).flatMap((k) => (values[k]?.trim() ? [[k, values[k]!.trim()]] : [])));
export interface ProbeResult { ok: boolean; detail: string; models?: string[] }
export const pluginOfInstance =(view: PluginsView, instance: string): PluginInfo | undefined => view.plugins.find((p) => p.id === view.instances.find((i) => i.id === instance)?.plugin);
