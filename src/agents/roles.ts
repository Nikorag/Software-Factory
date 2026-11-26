import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentRole, PermissionProfile } from "./types.js";

/** Role -> permission profile. A role can never exceed its profile; there is no per-call override. */
export const ROLE_PROFILE: Record<AgentRole, PermissionProfile> = {
  classifier: "read-only",
  assistant: "read-only",
  "requirements-analyst": "read-only",
  "prompt-writer": "read-only",
  "spec-writer": "spec-writer",
  "spec-reviewer": "read-only",
  implementer: "implementer",
  "qa-reviewer": "read-only",
  "security-reviewer": "read-only",
  "final-reviewer": "read-only",
};

const cache = new Map<AgentRole, string>();
/** Role prompts live in `agents/<role>.md` in the factory repo, so target repositories cannot alter them. */
export function rolePrompt(role: AgentRole): string {
  let p = cache.get(role);
  if (p === undefined) {
    p = readFileSync(fileURLToPath(new URL(`../../agents/${role}.md`, import.meta.url)), "utf8").trim();
    cache.set(role, p);
  }
  return p;
}
