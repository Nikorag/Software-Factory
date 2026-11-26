// What the hub's remote dashboard may do on this machine. SINGLE SOURCE OF TRUTH, default-deny.
//
// Remote requests are executed in-process through the same trust path as the local dashboard (loopback, x-factory-ui), so this
// list is the only thing standing between a hub session and a route. tests/remote-policy.test.ts enumerates every route the
// server registers and fails if one is not listed here, so a new route can never become remotely reachable by accident.

export type Effect = "allow" | "block";
export interface Rule { method: "GET" | "POST" | "PUT" | "DELETE"; pattern: string; effect: Effect; reason?: string }

const allow = (method: Rule["method"], ...patterns: string[]): Rule[] => patterns.map((pattern) => ({ method, pattern, effect: "allow" as const }));
const block = (method: Rule["method"], pattern: string, reason: string): Rule => ({ method, pattern, effect: "block", reason });

const SECRET = "handles a credential: set it on the machine itself";
const LIFECYCLE = "controls the factory process itself";
const LOCAL = "only makes sense on the machine running the factory";

export const RULES: readonly Rule[] = [
  // ---- reads: overview, jobs, logs, board, settings, status ----
  ...allow("GET",
    "/api/overview", "/api/health", "/api/jobs", "/api/jobs/:id", "/api/jobs/:id/invocations/:iid/conversation", "/api/jobs/:id/invocations/:iid/log",
    "/api/projects", "/api/tasks/:id", "/api/board",
    "/api/settings/global", "/api/setup", "/api/setup/github", "/api/setup/linear", "/api/update",
    // Read-only views of integration state. They report names/flags (hasToken, secretSet, connected), never a secret value.
    "/api/profiles", "/api/bitbucket/credentials", "/api/jira/status", "/api/jira/whoami", "/api/jira/mapping", "/api/jira/mapping/check", "/api/jira/metadata",
    // Tracker connections: ids, kinds, labels and whether credentials exist (and the NAME of the env var/keychain entry), never a value.
    "/api/trackers", "/api/github-issues/status", "/api/github-issues/whoami", "/api/github-issues/mapping"),

  // ---- factory control (the safe ones) ----
  ...allow("POST", "/api/control/pause", "/api/control/resume", "/api/control/stop", "/api/control/clear-stop"),
  block("POST", "/api/control/shutdown", LIFECYCLE),

  // ---- jobs and the board ----
  ...allow("POST", "/api/jobs/:id/answer", "/api/jobs/:id/archive", "/api/jobs/:id/unarchive", "/api/jobs/:id/cancel", "/api/jobs/:id/retry", "/api/board/start"),
  ...allow("DELETE", "/api/jobs/:id"),

  // The job chat: POST starts a read-only agent on this machine and returns at once; GET polls for the reply. (Asynchronous because a
  // tunnelled request must finish in seconds, and an answer can take minutes.) The agent can only read; it cannot change anything.
  ...allow("POST", "/api/jobs/:id/chat"), ...allow("GET", "/api/jobs/:id/chat/:cid"),

  // ---- settings that carry no secret ----
  ...allow("PUT", "/api/settings/global", "/api/settings/tracker", "/api/jira/mapping", "/api/github-issues/mapping"),
  // Tracker connections: create/rename/remove a NAMED connection. No credential is involved (those are set up separately, and blocked here).
  ...allow("POST", "/api/trackers"), ...allow("PUT", "/api/trackers/:id"), ...allow("DELETE", "/api/trackers/:id"),
  ...allow("POST", "/api/projects/:id/actions/:kind", "/api/setup/linear/:team/create", "/api/update/check"), // clone/validate/check/onboard; tracker setup; version check (not an update)
  // AMBIGUOUS, blocked pending a decision: project settings carry the repository path and the install/build/test shell commands,
  // so writing them remotely means choosing what runs on this machine (sandboxed, but with network for installs).
  block("PUT", "/api/settings/projects/:id", "edits a project's repository path and shell commands: decide deliberately, on the machine"),
  block("DELETE", "/api/settings/projects/:id", "removes a project from this machine's configuration: decide deliberately, on the machine"),

  // ---- credentials: never remotely ----
  block("POST", "/api/setup/linear-key", SECRET),
  block("PUT", "/api/bitbucket/credentials/:name", SECRET), block("DELETE", "/api/bitbucket/credentials/:name", SECRET), block("POST", "/api/bitbucket/credentials/:name/test", SECRET),
  block("PUT", "/api/jira/app", SECRET), block("POST", "/api/jira/connect", SECRET), block("POST", "/api/jira/disconnect", SECRET), block("POST", "/api/jira/site", SECRET),
  block("GET", "/api/jira/oauth/callback", LOCAL),

  // ---- the hub connection itself: a key, and whether the hub may operate this factory. Only ever from the machine. ----
  block("GET", "/api/hub", LOCAL), block("POST", "/api/hub/connect", SECRET), block("POST", "/api/hub/disconnect", LOCAL), block("PUT", "/api/hub/remote-access", "a hub session must not grant itself control"),

  // ---- safety settings (sandbox, protected paths, agent access): never from a hub session ----
  block("GET", "/api/settings/advanced", LOCAL), block("PUT", "/api/settings/advanced", "changes the sandbox, protected paths and agent access: decide on the machine"),

  // ---- profiles are separate local installs ----
  block("POST", "/api/profiles", LOCAL), block("DELETE", "/api/profiles/:name", LOCAL),

  // ---- the local dashboard's own files and health probe: the hub serves its own copy, never relays these ----
  block("GET", "/", LOCAL), block("GET", "/assets/:file", LOCAL), block("GET", "/health", LOCAL),
];

export const REMOTE_BLOCKED = "not available remotely";

export type Decision =
  | { allowed: true; route: string; mutating: boolean }
  | { allowed: false; reason: string; route?: string };

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

// Pattern -> regex. `:name` is one segment; `:name(a|b)` is one segment restricted to the alternatives.
const compiled = RULES.map((rule) => {
  const segs = rule.pattern.split("/").slice(1);
  const re = new RegExp("^" + segs.map((s) => { const m = /^:\w+\(([^)]+)\)$/.exec(s); return "/" + (m ? `(?:${m[1]})` : s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }).join("") + "$");
  return { rule, re, statics: segs.filter((s) => !s.startsWith(":")).length };
});

/** The most specific rule for a request (more literal segments win, so `/api/workflows/assignments` beats `/api/workflows/:id`). Unclassified = denied. */
export function classifyRemote(method: string, pathname: string): Decision {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  if (!METHODS.has(m)) return { allowed: false, reason: "method not supported remotely" };
  const hits = compiled.filter((c) => c.rule.method === m && c.re.test(pathname)).sort((a, b) => b.statics - a.statics || (a.rule.effect === "block" ? -1 : 1));
  const best = hits[0];
  if (!best) return { allowed: false, reason: "not classified for remote use" };
  if (best.rule.effect === "block") return { allowed: false, reason: best.rule.reason ?? "blocked", route: best.rule.pattern };
  return { allowed: true, route: best.rule.pattern, mutating: m !== "GET" };
}

export const MAX_PATH = 2048;

/** A request path from the hub must be a plain `/api/...` path (+ optional query). Returns the pathname, or null if it is not acceptable. */
export function validateRemotePath(raw: unknown): { pathname: string; url: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH) return null;
  if (!raw.startsWith("/api/")) return null;
  if (/[\u0000-\u001f\u007f\\#\s]/.test(raw)) return null;
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  if (path.includes("//") || path.split("/").some((s) => s === "." || s === "..")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  // Encoded slashes / dots / control characters could smuggle a different path past the checks above.
  if (/%2f|%5c|%2e/i.test(path) || /[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.includes("//") || decoded.split("/").some((s) => s === "." || s === "..")) return null;
  try { if (new URL(raw, "http://x.invalid").pathname !== path) return null; } catch { return null; }
  return { pathname: path, url: raw };
}
