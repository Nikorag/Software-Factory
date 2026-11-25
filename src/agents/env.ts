/**
 * Environment handed to agent subprocesses: an allowlist, not a denylist, so a secret we did not think of
 * is excluded by default. In particular this drops LINEAR_API_KEY, GH_TOKEN/GITHUB_TOKEN, ANTHROPIC_API_KEY
 * (its presence would silently switch Claude Code from the subscription to metered API billing), cloud
 * credentials and SSH_AUTH_SOCK.
 */
const ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "COLORTERM",
  "CLAUDE_CONFIG_DIR", "NVM_DIR", "NVM_BIN", "NVM_INC", "HOMEBREW_PREFIX", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
]);
const ALLOW_PREFIX = ["LC_"];

export function agentEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (ALLOW.has(k) || ALLOW_PREFIX.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return { ...out, ...extra, GIT_TERMINAL_PROMPT: "0", CI: "1" };
}
