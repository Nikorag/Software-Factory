import { mcpRules, pathRoots, toolPolicy } from "./permissions.js";
import { agentEnv } from "./env.js";
import { parseRateLimitInfo, type ClaudeLimits } from "./usage.js";
import { runProcess, type RunOptions, type RunResult } from "./process.js";
import type { Agent, AgentFailure, AgentRequest, AgentResult } from "./types.js";

/**
 * Claude Code CLI adapter. Flags verified against `claude --help` (2.1.332):
 *  -p/--print, --output-format stream-json (with --verbose), --json-schema, --tools, --allowedTools, --disallowedTools, --permission-mode,
 *  --setting-sources, --mcp-config, --strict-mcp-config, --model, --append-system-prompt, --resume, --no-session-persistence.
 * Deliberately NOT used: --bare (it never reads OAuth/keychain, so it cannot use a subscription login) and
 * --dangerously-skip-permissions.
 * MCP: `--mcp-config <json>` names the servers; with `--strict-mcp-config` ONLY those are used (no user/project/.mcp.json servers). The JSON
 * holds `${VAR}` references, never secret values (those travel in the subprocess environment, see McpGrant). With no grant, no `--mcp-config`
 * is passed and the arguments are exactly what they were before MCP existed. Tools are allowed as `mcp__<server>__*`.
 * The local (OpenAI-compatible) provider has no tool use, so it is never given MCP: see AgentRunner.
 */
export function buildClaudeArgs(req: AgentRequest): string[] {
  const mcpArgs = req.mcp?.names.length ? ["--mcp-config", JSON.stringify({ mcpServers: req.mcp.servers })] : [];
  // Only the implementer can be unrestricted: reviewers stay read-only so a review can never change the code it reviews.
  if (req.access === "unrestricted" && req.profile === "implementer") return finishArgs(req, [
    "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "auto", // the same mode an interactive auto-mode session uses; settings files load as they would there
    ...mcpArgs,
    "--strict-mcp-config",
    ...(mcpArgs.length ? ["--allowedTools", ...mcpRules(req.mcp?.names)] : []), // auto mode has no factory tool lists: only the MCP grant is added
  ]);
  const policy = toolPolicy(req.profile, { protectedPaths: req.protectedPaths, bashAllow: req.bashAllow, bashAny: req.bashAny, roots: pathRoots(req.cwd), readPaths: req.readPaths, mcpServers: req.mcp?.names });
  return finishArgs(req, [
    "-p",
    "--output-format", "stream-json", "--verbose", // one JSON event per line, as it happens: the whole conversation is logged live, and the last line is the result
    "--permission-mode", "dontAsk", // anything not explicitly allowed is refused, never prompted for
    "--setting-sources", "", // ignore user/project settings files: the factory defines permissions, not the repo
    ...mcpArgs,
    "--strict-mcp-config", // no MCP servers unless the factory passes some
    "--tools", policy.tools.join(","),
    "--allowedTools", ...policy.allow,
    "--disallowedTools", ...policy.deny,
  ]);
}

function finishArgs(req: AgentRequest, args: string[]): string[] {
  if (req.model && req.model !== "default") args.push("--model", req.model);
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  else if (!req.persistSession) args.push("--no-session-persistence");
  return args;
}

interface RawResult {
  type?: string; subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown;
  session_id?: string; total_cost_usd?: number; usage?: Record<string, unknown>; num_turns?: number;
  api_error_status?: number | null; terminal_reason?: string;
  permission_denials?: { tool_name?: string; tool_input?: unknown }[];
}

export function classifyFailure(raw: RawResult | undefined, stderr: string, exitCode: number | null): AgentFailure {
  const status = raw?.api_error_status ?? undefined;
  const text = `${raw?.result ?? ""} ${stderr}`.toLowerCase();
  if (status === 401 || status === 403 || /invalid api key|not logged in|please run \/login|authentication/.test(text)) return "auth";
  if (status === 429 || /rate limit|usage limit|limit reached|too many requests/.test(text)) return "rate_limited";
  if ((status && status >= 500) || /overloaded|timed? ?out|econnreset|socket hang up|network/.test(text)) return "transient";
  void exitCode;
  return "error";
}

/** Pure: turn the CLI's stdout/stderr/exit into an AgentResult. */
export function parseClaudeOutput(run: Pick<RunResult, "stdout" | "stderr" | "exitCode" | "durationMs">): AgentResult {
  let raw: RawResult | undefined;
  let limits: ClaudeLimits | undefined;
  // stream-json: one event per line and the last `result` event carries the outcome. A single JSON document is still understood.
  for (const line of run.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as RawResult & { rate_limit_info?: unknown };
      if (o.type === "result") raw = o;
      else if (o.type === "rate_limit_event") limits = parseRateLimitInfo(o.rate_limit_info) ?? limits; // the last reading wins
    } catch { /* a partial or non-JSON line */ }
  }
  if (!raw) { try { raw = JSON.parse(run.stdout) as RawResult; } catch { /* handled below */ } }
  const denials = (raw?.permission_denials ?? []).map((d) => ({ tool: d.tool_name ?? "?", input: JSON.stringify(d.tool_input ?? {}).slice(0, 4000) })); // long enough for any absolute path (approvals read it)
  const base = { denials, exitCode: run.exitCode, durationMs: run.durationMs, ...(limits ? { limits } : {}) };
  if (!raw || raw.type !== "result") {
    return { ...base, ok: false, text: run.stdout.slice(-2000), failure: classifyFailure(undefined, run.stderr, run.exitCode), error: `unparseable Claude Code output (exit ${run.exitCode}): ${run.stderr.slice(0, 500)}` };
  }
  const common = { ...base, text: raw.result ?? "", sessionId: raw.session_id, costUsd: raw.total_cost_usd, usage: raw.usage, numTurns: raw.num_turns };
  if (raw.is_error || raw.subtype !== "success" || (run.exitCode ?? 0) !== 0) {
    return { ...common, ok: false, failure: classifyFailure(raw, run.stderr, run.exitCode), error: raw.result || raw.subtype || `exit ${run.exitCode}` };
  }
  return { ...common, ok: true, structured: raw.structured_output };
}

export interface ClaudeCodeOptions {
  bin?: string; env?: NodeJS.ProcessEnv; run?: (o: RunOptions) => Promise<RunResult>;
  /** Identity on commits the agent makes. Never the user's own: AI-written commits must not be attributed to a person. */
  gitIdentity?: { name: string; email: string };
}
export const FACTORY_GIT_IDENTITY = { name: "Software Factory", email: "factory@localhost" };

// Environment beats git config, so a user's own global identity cannot leak into agent commits.
const gitEnv = (i: { name: string; email: string }) => ({ GIT_AUTHOR_NAME: i.name, GIT_AUTHOR_EMAIL: i.email, GIT_COMMITTER_NAME: i.name, GIT_COMMITTER_EMAIL: i.email });

export class ClaudeCodeAgent implements Agent {
  readonly provider = "anthropic" as const;
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const args = buildClaudeArgs(req);
    const r = await (this.opts.run ?? runProcess)({
      cmd: this.opts.bin ?? "claude", args, cwd: req.cwd, env: agentEnv(this.opts.env ?? process.env, { ...gitEnv(this.opts.gitIdentity ?? FACTORY_GIT_IDENTITY), ...req.mcp?.env }),
      stdin: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, logFile: req.logFile,
    });
    const meta = { durationMs: r.durationMs, exitCode: r.exitCode, denials: [] as AgentResult["denials"], logFile: req.logFile };
    if (r.spawnError) return { ...meta, ok: false, text: "", failure: "error", error: `could not start ${this.opts.bin ?? "claude"}: ${r.spawnError}` };
    if (r.cancelled) return { ...meta, ok: false, text: r.stdout.slice(-2000), failure: "cancelled", error: "cancelled" };
    if (r.timedOut) return { ...meta, ok: false, text: r.stdout.slice(-2000), failure: "timeout", error: `exceeded ${Math.round(req.timeoutMs / 1000)}s` };
    return { ...parseClaudeOutput(r), logFile: req.logFile };
  }
}
