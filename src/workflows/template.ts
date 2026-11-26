/**
 * Prompt templates: `{{variable}}` placeholders and nothing else (no logic, no expressions, no code). One pass, so text that happens to
 * contain braces (a ticket body, a finding) is inserted as-is and never expanded again.
 */
export const PROMPT_VARIABLES: { name: string; description: string }[] = [
  { name: "ticket.identifier", description: "The ticket key, e.g. ENG-123" },
  { name: "ticket.title", description: "The ticket title" },
  { name: "ticket.description", description: "The ticket description" },
  { name: "ticket.url", description: "Link to the ticket" },
  { name: "ticket.labels", description: "The ticket's labels, comma separated" },
  { name: "project.id", description: "The factory project id" },
  { name: "project.name", description: "The project name" },
  { name: "repo.path", description: "The job worktree's path" },
  { name: "repo.baseSha", description: "The commit the job branch was created from" },
  { name: "repo.branch", description: "The job's branch name" },
  { name: "workflow.name", description: "This workflow's name" },
  { name: "workflow.version", description: "This workflow's version when the job started" },
  { name: "stage.id", description: "This stage's id" },
  { name: "stage.name", description: "This stage's name" },
  { name: "spec.dir", description: "The specification directory for the ticket (specs/<key>-<slug>)" },
  { name: "job.id", description: "The job id" },
  { name: "job.key", description: "The ticket key the job works on" },
  { name: "job.attempt", description: "This stage's attempt number" },
  { name: "answers", description: "Every answer a person has given to this job's questions, with the question each answers" },
  { name: "findings", description: "The blocking findings of the review or check that sent the job here (empty on a first pass)" },
  { name: "outputs.<STAGE_ID>", description: "The latest output of an earlier stage, as JSON; outputs.<STAGE_ID>.<field> picks one top-level field" },
];

const FIXED = new Set(PROMPT_VARIABLES.filter((v) => !v.name.includes("<")).map((v) => v.name));
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const OUTPUT_REF = /^outputs\.([A-Za-z][A-Za-z0-9_]{0,47})(\.[A-Za-z0-9_]{1,40})?$/;

export interface PromptIssue { variable: string; message: string }

/** Names used in a template, in order of first use. */
export function variablesIn(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN)].map((m) => m[1]!))];
}

const common = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/** The documented variable that shares the longest prefix with a mistyped one (within the same root, e.g. ticket.*). */
const closest = (name: string): string | undefined => {
  const root = name.split(".")[0]!;
  return [...FIXED].filter((v) => v === root || v.startsWith(`${root}.`)).sort((a, b) => common(b, name) - common(a, name))[0];
};

/** Unknown or unavailable variables, with a message that says what to use instead. `stageIds`: the stages of the workflow (for outputs.<id>). */
export function validatePromptVariables(template: string, stageIds: ReadonlySet<string>, self?: string): PromptIssue[] {
  const issues: PromptIssue[] = [];
  const opens = (template.match(/\{\{/g) ?? []).length, closes = (template.match(/\}\}/g) ?? []).length;
  if (opens !== closes || opens !== [...template.matchAll(TOKEN)].length) issues.push({ variable: "", message: "unbalanced or malformed {{ }}: a placeholder is {{ name }} with nothing else inside" });
  for (const v of variablesIn(template)) {
    if (FIXED.has(v)) continue;
    const o = OUTPUT_REF.exec(v);
    if (o) {
      if (!stageIds.has(o[1]!)) issues.push({ variable: v, message: `{{${v}}}: this workflow has no stage "${o[1]}"` });
      else if (o[1] === self) issues.push({ variable: v, message: `{{${v}}}: a stage cannot read its own output` });
      continue;
    }
    const hint = closest(v);
    issues.push({ variable: v, message: `unknown variable {{${v}}}${hint ? ` (did you mean {{${hint}}}?)` : ""}. See the variable list in the editor.` });
  }
  return issues;
}

/** Fills the template. A variable with no value renders as an empty string. `values` is a lookup so the engine only computes what a template uses. */
export function renderPrompt(template: string, values: Record<string, string> | ((name: string) => string | undefined)): string {
  const get = typeof values === "function" ? values : (n: string) => values[n];
  return template.replace(TOKEN, (_m, name: string) => get(name) ?? "");
}

/** Variables that need the live ticket or the worktree: available to agent and review prompts, not to a factory stage's extra instructions. */
export const TICKET_SCOPED = /^(ticket|repo|spec)\./;
