import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ConfigError, expandHome } from "./load.js";
import { SkillRef } from "./schema.js";

/**
 * Skills: operator-supplied instruction files (a SKILL.md) that are appended to the system prompt of every agent run for a project.
 * They can only be set in projects.yaml and the profile's factory.yaml (never in a repository's `.software-factory.yml`: lower trust).
 * The path is stored, not the body, so editing the file takes effect on the next run.
 */
export const SKILL_MAX_BYTES = 32 * 1024;
/** The loose shape the settings forms submit; `validateSkills` then gives readable ConfigErrors. */
export const SkillRefInput = z.object({ name: z.string().max(200), path: z.string().max(500) });

/** The SKILL.md a reference points at: the file itself, or SKILL.md inside the folder. Throws ConfigError when there is none. */
export function skillFile(ref: SkillRef): string {
  const p = expandHome(ref.path.trim());
  if (!isAbsolute(p)) throw new ConfigError(`skill "${ref.name}": path must be absolute (or start with ~/): ${ref.path}`);
  let st;
  try { st = statSync(p); } catch { throw new ConfigError(`skill "${ref.name}": path does not exist or is not readable: ${ref.path}`); }
  const file = st.isDirectory() ? join(p, "SKILL.md") : p;
  if (st.isDirectory()) { try { st = statSync(file); } catch { throw new ConfigError(`skill "${ref.name}": no SKILL.md in folder ${ref.path}`); } }
  if (!st.isFile()) throw new ConfigError(`skill "${ref.name}": not a file: ${ref.path}`);
  if (st.size > SKILL_MAX_BYTES) throw new ConfigError(`skill "${ref.name}": ${file} is larger than ${SKILL_MAX_BYTES / 1024} KB`);
  return file;
}

/** The skill's text without its YAML front matter. Throws ConfigError if the file is missing, unreadable or too large. */
export function readSkillBody(ref: SkillRef): string {
  const file = skillFile(ref);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new ConfigError(`skill "${ref.name}": cannot read ${file}`); }
  if (Buffer.byteLength(text) > SKILL_MAX_BYTES) throw new ConfigError(`skill "${ref.name}": ${file} is larger than ${SKILL_MAX_BYTES / 1024} KB`);
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** Save-time check of a list: slug names, no duplicates, every path readable and under the size cap. */
export function validateSkills(list: readonly { name: string; path: string }[] | undefined): SkillRef[] {
  const out: SkillRef[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const r = SkillRef.safeParse({ name: raw.name.trim(), path: raw.path.trim() });
    if (!r.success) throw new ConfigError(`skill "${raw.name}": ${r.error.issues.map((i) => i.message).join("; ")}`);
    if (seen.has(r.data.name)) throw new ConfigError(`skill "${r.data.name}" is listed twice`);
    seen.add(r.data.name);
    skillFile(r.data);
    out.push(r.data);
  }
  return out;
}

/** The skills a project's agents get: the profile's, with a project skill replacing a profile skill of the same name. Pure. */
export function effectiveSkills(profile: readonly SkillRef[] | undefined, project: readonly SkillRef[] | undefined): SkillRef[] {
  const byName = new Map<string, SkillRef>();
  for (const s of profile ?? []) byName.set(s.name, s);
  for (const s of project ?? []) byName.set(s.name, s);
  return [...byName.values()];
}

/** The delimited block appended to the system prompt; "" when there are no skills. Reads the files now (so edits apply on the next run). */
export function skillsPromptBlock(skills: readonly SkillRef[]): string {
  if (!skills.length) return "";
  return skills.map((s) => `\n\n## Skill: ${s.name}\n\n${readSkillBody(s)}\n\n## End skill: ${s.name}`).join("");
}
