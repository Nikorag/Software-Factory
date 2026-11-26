import { z } from "zod";
import { COMPLETE, FACTORY_HANDLERS, RESERVED_IDS, WorkflowDefinition, type Gate, type Stage } from "./definition.js";
import { gateSize } from "./gates.js";
import { CompiledWorkflow } from "./graph.js";
import { SYSTEM_LIMITS } from "./limits.js";
import { MANDATORY_GATES, TOOL_HANDLERS, isMutatingHandler } from "./safety.js";
import { STAGE_TYPE_SPECS } from "./stage-types.js";
import { TICKET_SCOPED, validatePromptVariables, variablesIn } from "./template.js";

export interface Issue { path: string; message: string; severity: "error" | "warning" }
export type ValidationResult =
  | { ok: true; definition: WorkflowDefinition; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

const KNOWN_ANTHROPIC = /^(default|haiku|sonnet|opus|claude-[a-z0-9.-]+)$/;

const zodIssues = (e: z.ZodError): Issue[] => e.issues.map((i) => ({ path: i.path.join("."), message: i.message, severity: "error" as const }));

/** Gate kinds that only make sense for some stage types. */
const needsVerdict = new Set(["verdict_approved", "no_blocking_findings"]);
const needsExit = new Set(["exit_code_zero", "tests_passed"]);
function gateLeaves(g: Gate): Gate[] { return g.type === "all" || g.type === "any" ? g.of.flatMap(gateLeaves) : [g]; }

/**
 * Parses and validates a definition: schema, per-type settings, prompt variables, routes, loop safety and the mandatory safety gates.
 * Returns the normalised definition (defaults filled in) or every problem found, so the editor can show them all before saving.
 */
export function validateDefinition(raw: unknown): ValidationResult {
  const parsed = WorkflowDefinition.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings: [] };
  const def = parsed.data;
  const errors: Issue[] = [], warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) => warnings.push({ path, message, severity: "warning" });

  const ids = new Set<string>();
  def.stages.forEach((s, i) => {
    if (ids.has(s.id)) err(`stages.${i}.id`, `duplicate stage id "${s.id}"`);
    ids.add(s.id);
    if (RESERVED_IDS.includes(s.id)) err(`stages.${i}.id`, `"${s.id}" is a reserved job state, not a stage id`);
  });

  // ---- per-stage checks (and normalise `config` through the type's own schema) ----
  const stages: Stage[] = def.stages.map((s, i): Stage => {
    const at = `stages.${i}`;
    const spec = STAGE_TYPE_SPECS[s.type];
    let config = s.config;
    const c = spec.configSchema.safeParse(s.config);
    if (c.success) config = c.data as Record<string, unknown>;
    else for (const x of c.error.issues) err(`${at}.config${x.path.length ? "." + x.path.join(".") : ""}`, x.message);

    if (s.type === "factory") {
      if (!s.handler || !FACTORY_HANDLERS.includes(s.handler)) err(`${at}.handler`, `a factory stage must name one of the built-in handlers (${FACTORY_HANDLERS.length} available)`);
      else if (s.id !== s.handler) err(`${at}.id`, `a factory stage's id must equal its handler ("${s.handler}"): the handler records and reads its work under that name`);
      if (s.prompt?.template) err(`${at}.prompt.template`, "a factory stage's prompt is built in; add to it with extra instructions instead");
      if (s.model?.provider === "local" && s.handler && TOOL_HANDLERS.has(s.handler)) err(`${at}.model.provider`, `${s.handler} needs file and shell tools, so its model must be a Claude Code (anthropic) model`);
    } else {
      if (s.handler) err(`${at}.handler`, "only factory stages take a handler");
      if (FACTORY_HANDLERS.includes(s.id)) err(`${at}.id`, `"${s.id}" is the name of a built-in stage: pick another id`);
      if (s.prompt?.instructions) err(`${at}.prompt.instructions`, "this stage type has a prompt template, not extra instructions");
    }
    if (!spec.usesModel && s.model) err(`${at}.model`, `${spec.label} stages do not use a model`);
    if (s.type !== "agent" && s.type !== "review" && s.type !== "factory" && s.prompt) err(`${at}.prompt`, `${spec.label} stages have no prompt`);
    if (s.model?.model && s.model.provider === "anthropic" && !KNOWN_ANTHROPIC.test(s.model.model)) warn(`${at}.model.model`, `"${s.model.model}" is not a known Claude alias or id: Claude Code will reject it if it is wrong`);
    if (s.model?.model && !s.model.provider) warn(`${at}.model.provider`, "no provider chosen: the model id is applied to the stage's configured provider");

    // prompt variables
    for (const [field, text] of [["template", s.prompt?.template], ["instructions", s.prompt?.instructions]] as const) {
      if (text) for (const p of validatePromptVariables(text, ids, s.id)) err(`${at}.prompt.${field}`, p.message);
    }
    if (s.prompt?.instructions) for (const v of variablesIn(s.prompt.instructions)) if (TICKET_SCOPED.test(v)) err(`${at}.prompt.instructions`, `{{${v}}} is not available in extra instructions (the stage's own prompt already carries the ticket); use it in an agent or review stage's prompt`);

    if (!s.enabled && s.required) err(`${at}.enabled`, `"${s.id}" is required, so it cannot be disabled: mark it optional first`);
    if (s.runIf && s.required) err(`${at}.runIf`, `"${s.id}" is required, so it cannot be conditional: mark it optional first`);
    if (s.runIf?.field.startsWith("outputs.")) { const ref = s.runIf.field.split(".")[1]!; if (!ids.has(ref)) err(`${at}.runIf.field`, `no stage "${ref}"`); }

    // gate
    const size = gateSize(s.successGate);
    if (size.depth > SYSTEM_LIMITS.maxGateDepth) err(`${at}.successGate`, `gates nest at most ${SYSTEM_LIMITS.maxGateDepth} levels deep`);
    if (size.nodes > SYSTEM_LIMITS.maxGateNodes) err(`${at}.successGate`, `a gate has at most ${SYSTEM_LIMITS.maxGateNodes} conditions`);
    for (const leaf of gateLeaves(s.successGate)) {
      if (needsVerdict.has(leaf.type) && (s.type === "agent" || s.type === "check")) err(`${at}.successGate`, `${leaf.type} needs a verdict, which a ${spec.label.toLowerCase()} stage does not produce`);
      if (needsExit.has(leaf.type) && (s.type === "agent" || s.type === "review")) err(`${at}.successGate`, `${leaf.type} needs a command's exit code, which a ${spec.label.toLowerCase()} stage does not produce`);
      if (leaf.type === "condition" && leaf.condition.field.startsWith("outputs.") && !ids.has(leaf.condition.field.split(".")[1]!)) err(`${at}.successGate`, `no stage "${leaf.condition.field.split(".")[1]}"`);
    }

    // requires / next
    for (const r of s.requires) { if (!ids.has(r)) err(`${at}.requires`, `no stage "${r}"`); else if (r === s.id) err(`${at}.requires`, "a stage cannot require itself"); }
    if (s.next && s.next !== COMPLETE && !ids.has(s.next)) err(`${at}.next`, `no stage "${s.next}"`);
    if (s.type === "conditional") {
      const cc = config as { then?: string; else?: string; condition?: { field: string } };
      for (const k of ["then", "else"] as const) if (cc[k] && cc[k] !== COMPLETE && !ids.has(cc[k]!)) err(`${at}.config.${k}`, `no stage "${cc[k]}"`);
      if (cc.condition?.field.startsWith("outputs.") && !ids.has(cc.condition.field.split(".")[1]!)) err(`${at}.config.condition.field`, `no stage "${cc.condition.field.split(".")[1]}"`);
    }

    // failure rules
    s.onFailure.forEach((r, j) => {
      const rp = `${at}.onFailure.${j}`;
      if (r.action === "goto") {
        if (!ids.has(r.target!)) err(`${rp}.target`, `no stage "${r.target}"`);
        else if (!def.stages.find((x) => x.id === r.target)!.enabled) err(`${rp}.target`, `"${r.target}" is disabled`);
      }
      if (r.action === "skip" && s.required) err(`${rp}.action`, `"${s.id}" is required, so a failure cannot skip it: mark the stage optional first`);
      if (r.action === "retry" && s.retry.max === 0) warn(`${rp}.action`, "retry is configured but the stage allows 0 retries");
    });
    return { ...s, config };
  });

  const normalised: WorkflowDefinition = { ...def, stages };
  if (errors.length) return { ok: false, errors, warnings };

  // ---- graph checks ----
  const g = new CompiledWorkflow(normalised);
  if (!stages.some((s) => s.enabled)) err("stages", "the workflow has no enabled stage");

  // success-path loops: every cycle must go through a failure route (which spends a bounded fix-cycle budget)
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    if (id === COMPLETE || !g.stage(id)) return;
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { err("stages", `the success path loops forever: ${[...trail.slice(trail.indexOf(id)), id].join(" -> ")}. Go back with a failure route (it is bounded), not with "next"`); return; }
    state.set(id, 1);
    for (const n of g.successors(id)) visit(n, [...trail, id]);
    state.set(id, 2);
  };
  for (const s of stages) if (s.enabled) visit(s.id, []);

  if (!errors.length) {
    const reach = g.reachableFrom(g.entry);
    for (const s of stages) if (s.enabled && !reach.has(s.id)) warn(`stages.${stages.indexOf(s)}`, `"${s.id}" can never run: no stage leads to it`);

    // ---- mandatory safety gates ----
    const byHandler = new Map(stages.filter((s) => s.type === "factory").map((s) => [s.handler!, s]));
    const guardedMutating = stages.filter((s) => s.enabled && ((s.type === "factory" && isMutatingHandler(s.handler!)) || (s.type !== "factory" && s.mutating)));
    for (const m of MANDATORY_GATES) {
      const guarded = m.guards === "mutating" ? guardedMutating.filter((s) => s.id !== m.handler) : stages.filter((s) => s.enabled && s.type === "factory" && (m.guards as string[]).includes(s.handler!));
      if (guarded.length === 0) continue;
      const at = byHandler.get(m.handler);
      const why = `${m.handler} is a mandatory safety stage (${m.why}); this workflow contains ${guarded.map((s) => s.id).join(", ")}`;
      if (!at) { err("stages", `missing ${why}`); continue; }
      const idx = `stages.${stages.indexOf(at)}`;
      if (!at.enabled) err(`${idx}.enabled`, `${m.handler} cannot be disabled: ${why}`);
      if (!at.required) err(`${idx}.required`, `${m.handler} must stay required: ${why}`);
      if (at.runIf) err(`${idx}.runIf`, `${m.handler} cannot be conditional: ${why}`);
      if (at.onFailure.some((r) => r.action === "skip")) err(`${idx}.onFailure`, `${m.handler} cannot be skipped on failure: ${why}`);
      // dominance: with the gate removed from the graph, no guarded stage may still be reachable from the start
      if (at.enabled && g.entry !== at.id) {
        const around = g.reachableFrom(g.entry, at.id);
        for (const s of guarded) if (around.has(s.id)) err("stages", `${s.id} can be reached without passing through ${m.handler}: ${why}`);
      } else if (at.enabled && g.entry === at.id) { /* first stage: everything passes through it */ }
    }
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, definition: normalised, warnings };
}

/** Throws with every problem when a definition is not valid. */
export function assertValid(raw: unknown): WorkflowDefinition {
  const r = validateDefinition(raw);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.path || "workflow"}: ${e.message}`).join("; "));
  return r.definition;
}
