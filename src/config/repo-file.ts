import { parse } from "yaml";
import { z } from "zod";
import { git as realGit, type GitFn } from "../repo/git.js";
import { assertNoSecrets, ConfigError } from "./load.js";
import { ProjectCommands, ProjectConfig, ProjectGithub, ProjectId } from "./schema.js";

/**
 * `.software-factory.yml`: a project's own factory settings, kept with its code.
 *
 * Precedence (the one place it is documented): projects.yaml is the registry (id, enabled, tracker/linear bindings, autonomy, overrides...).
 * For the fields this file sets (name, defaultBranch, github.account/repo, commands.*, allowLoopback) the file WINS; fields it omits keep
 * the projects.yaml value or the default. `commands` and `github` merge key by key.
 *
 * Trust: the file is read ONLY from the committed default branch (origin/<defaultBranch>, else the local branch), never from a job's
 * worktree or the working copy, so a job cannot change its own commands. It has the same trust as the repo's package scripts:
 * `commands.install` runs with network access and `allowLoopback` loosens the sandbox. See SECURITY.md.
 */
export const REPO_FILE = ".software-factory.yml";
const MAX_BYTES = 64 * 1024;

/** Strict: an unknown key or a typo (`commands.tset`) is an error, not silently ignored. Field definitions come from ProjectConfig. */
export const RepoFile = z.strictObject({
  id: ProjectId,
  name: ProjectConfig.shape.name.optional(),
  defaultBranch: z.string().min(1).max(100).optional(),
  github: ProjectGithub.strict().optional(),
  commands: ProjectCommands.strict().optional(),
  allowLoopback: z.boolean().optional(),
});
export type RepoFile = z.infer<typeof RepoFile>;

/** Parses and validates the file's text for `projectId`. Throws a ConfigError naming the path of every problem. */
export function parseRepoFile(text: string, projectId: string): RepoFile {
  let raw: unknown;
  try { raw = parse(text) ?? {}; } catch (e) { throw new ConfigError(`${REPO_FILE}: not valid YAML: ${(e as Error).message.split("\n")[0]}`); }
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new ConfigError(`${REPO_FILE}: expected one project, found ${raw.length}`);
    raw = raw[0];
  }
  assertNoSecrets(raw, REPO_FILE);
  const r = RepoFile.safeParse(raw);
  if (!r.success) throw new ConfigError(`${REPO_FILE}:\n${r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  if (r.data.id !== projectId) throw new ConfigError(`${REPO_FILE}: id "${r.data.id}" does not match this project's id "${projectId}" in projects.yaml`);
  return r.data;
}

type Settable = Pick<ProjectConfig, "name" | "defaultBranch" | "github" | "commands" | "allowLoopback">;
const pick = (p: Settable): Settable => ({ name: p.name, defaultBranch: p.defaultBranch, github: { ...p.github }, commands: { ...p.commands }, allowLoopback: p.allowLoopback });
const defined = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The precedence merge: what the file sets beats `base`; what it omits stays. Pure. */
export function mergeRepoFile(base: Settable, file: RepoFile): Settable {
  return {
    name: file.name ?? base.name,
    defaultBranch: file.defaultBranch ?? base.defaultBranch,
    github: { ...base.github, ...defined(file.github) },
    commands: { ...base.commands, ...defined(file.commands) },
    allowLoopback: file.allowLoopback ?? base.allowLoopback,
  };
}

/** The committed text of the file on the default branch, or null when there is none (or no such branch yet). Never reads the working copy. */
export async function readRepoFileText(project: Pick<ProjectConfig, "repository" | "defaultBranch">, git: GitFn = realGit): Promise<string | null> {
  const repo = project.repository, b = project.defaultBranch;
  let ref: string | null = null;
  for (const c of [`refs/remotes/origin/${b}`, `refs/heads/${b}`]) {
    if (await git(repo, ["rev-parse", "--verify", "--quiet", c]).then(() => true, () => false)) { ref = c; break; }
  }
  if (!ref) return null;
  const listed = await git(repo, ["ls-tree", "--name-only", ref, "--", REPO_FILE]).catch(() => "");
  if (!listed) return null;
  const text = await git(repo, ["cat-file", "blob", `${ref}:${REPO_FILE}`]);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new ConfigError(`${REPO_FILE}: larger than ${MAX_BYTES / 1024} KB`);
  return text;
}

// What was last read per project. Survives a settings save (applyProjects swaps in fresh project objects) so the file keeps winning.
interface State { base?: Settable; overlay?: RepoFile; error?: string }
const states = new WeakMap<ProjectConfig, State>();

function applyState(project: ProjectConfig, s: State): void {
  s.base ??= pick(project);
  Object.assign(project, s.overlay ? mergeRepoFile(s.base, s.overlay) : s.base);
  if (s.error) project.repoFileError = s.error; else delete project.repoFileError;
}

export type RepoFileOutcome = { status: "none" | "applied" | "error"; error?: string };

/**
 * Reads the file for `project` and applies it in place (the engine, scheduler and server all hold this object). A missing file leaves
 * the settings as they were; an invalid one applies NOTHING, keeps the previous settings and records the error on the project. Never throws.
 */
export async function refreshRepoFile(project: ProjectConfig, git: GitFn = realGit): Promise<RepoFileOutcome> {
  const s = states.get(project) ?? {};
  states.set(project, s);
  try {
    const text = await readRepoFileText(project, git);
    if (text === null) { delete s.overlay; delete s.error; applyState(project, s); return { status: "none" }; }
    s.overlay = parseRepoFile(text, project.id);
    delete s.error;
    applyState(project, s);
    return { status: "applied" };
  } catch (e) {
    s.error = (e instanceof ConfigError ? e.message : `${REPO_FILE}: could not be read: ${(e as Error).message}`);
    applyState(project, s); // previous overlay (if any) stays in effect
    return { status: "error", error: s.error };
  }
}

/** After projects.yaml is re-read (a settings save): the new objects start from projects.yaml again, so put the last good file back on top. */
export function carryRepoFiles(old: readonly ProjectConfig[], fresh: readonly ProjectConfig[]): void {
  for (const p of fresh) {
    const s = old.map((o) => (o.id === p.id ? states.get(o) : undefined)).find(Boolean);
    if (!s) continue;
    delete s.base; // the freshly loaded project IS the new projects.yaml base
    states.set(p, s);
    applyState(p, s);
  }
}
