import type { TrackerEntry } from "./types";

/**
 * Adds `?tracker=<id>` to an API path unless `id` is the one the server assumes anyway (`implicit`): the built-in "jira" for the Jira routes,
 * the built-in "github" for the GitHub ones, the profile's default for the setup routes. Keeps the common single-tracker case's URLs unchanged.
 */
export function withTracker(path: string, id: string | undefined, implicit: string): string {
  if (!id || id === implicit) return path;
  return `${path}${path.includes("?") ? "&" : "?"}tracker=${encodeURIComponent(id)}`;
}

export const KIND_NAME = { linear: "Linear", jira: "Jira", github: "GitHub Issues" } as const;
export type TrackerKind = keyof typeof KIND_NAME;

/** What the project editor and the trackers panel say for each kind of tracker. */
export const WORDS: Record<TrackerKind, { team: string; project: string; whole: string; none: string; hint?: string; placeholder: string }> = {
  linear: { team: "Team key", project: "Project", whole: "(whole team)", none: "(none)", placeholder: "ENG" },
  jira: { team: "Jira project", project: "Component (optional)", whole: "(whole Jira project)", none: "(choose)", hint: "Tickets of this Jira project (and, if you choose one, this component) belong to this repository.", placeholder: "ENG" },
  github: { team: "Issues repository", project: "Milestone (optional)", whole: "(whole repository)", none: "(choose)", hint: "Issues of this GitHub repository (and, if you choose one, this milestone) belong to this project.", placeholder: "owner/repo" },
};

/** The three built-in connections, used until the server's list arrives (and when it cannot be read). */
export const BUILTIN_ENTRIES = (defaultId: string): TrackerEntry[] =>
  (["linear", "jira", "github"] as const).map((id) => ({ id, kind: id, label: KIND_NAME[id], builtin: true, isDefault: id === defaultId, connected: false, projects: [] }));
