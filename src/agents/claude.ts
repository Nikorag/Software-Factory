import { pathRoots, toolPolicy } from "./permissions.js";
import { agentEnv } from "./env.js";
import { runProcess, type RunOptions, type RunResult } from "./process.js";
import type { Agent, AgentFailure, AgentRequest, AgentResult } from "./types.js";

/**
 * Claude Code CLI adapter. Flags verified against `claude --help` (2.1.332):
 *  -p/--print, --output-format json, --json-schema, --tools, --allowedTools, --disallowedTools, --permission-mode,
 *  --setting-sources, --strict-mcp-config, --model, --append-system-prompt, --resume, --no-session-persistence.
 * Deliberately NOT used: --bare (it never reads OAuth/keychain, so it cannot use a subscription login) and
 * --dangerously-skip-permissions.
 */
export function buildClaudeArgs(req: AgentRequest): string[] {
  const policy = toolPolicy(req.profile, { protectedPaths: req.protectedPaths, bashAllow: req.bashAllow, roots: pathRoots(req.cwd) });
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "dontAsk", // anything not explicitly allowed is refused, never prompted for
    "--setting-sources", "", // ignore user/project settings files: the factory defines permissions, not the repo
    "--strict-mcp-config", // no MCP servers unless the factory passes some
    "--tools", policy.tools.join(","),
    "--allowedTools", ...policy.allow,
    "--disallowedTools", ...policy.deny,
  ];
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
  try { raw = JSON.parse(run.stdout) as RawResult; } catch { /* handled below */ }
  const denials = (raw?.permission_denials ?? []).map((d) => ({ tool: d.tool_name ?? "?", input: JSON.stringify(d.tool_input ?? {}).slice(0, 300) }));
  const base = { denials, exitCode: run.exitCode, durationMs: run.durationMs };
  if (!raw || raw.type !== "result") {
    return { ...base, ok: false, text: run.stdout.slice(0, 2000), failure: classifyFailure(undefined, run.stderr, run.exitCode), error: `unparseable Claude Code output (exit ${run.exitCode}): ${run.stderr.slice(0, 500)}` };
  }
  const common = { ...base, text: raw.result ?? "", sessionId: raw.session_id, costUsd: raw.total_cost_usd, usage: raw.usage, numTurns: raw.num_turns };
  if (raw.is_error || raw.subtype !== "success" || (run.exitCode ?? 0) !== 0) {
    return { ...common, ok: false, failure: classifyFailure(raw, run.stderr, run.exitCode), error: raw.result || raw.subtype || `exit ${run.exitCode}` };
  }
  return { ...common, ok: true, structured: raw.structured_output };
}

export interface ClaudeCodeOptions { bin?: string; env?: NodeJS.ProcessEnv; run?: (o: RunOptions) => Promise<RunResult> }

export class ClaudeCodeAgent implements Agent {
  readonly provider = "anthropic" as const;
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const args = buildClaudeArgs(req);
    const r = await (this.opts.run ?? runProcess)({
      cmd: this.opts.bin ?? "claude", args, cwd: req.cwd, env: agentEnv(this.opts.env ?? process.env),
      stdin: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, logFile: req.logFile,
    });
    const meta = { durationMs: r.durationMs, exitCode: r.exitCode, denials: [] as AgentResult["denials"], logFile: req.logFile };
    if (r.spawnError) return { ...meta, ok: false, text: "", failure: "error", error: `could not start ${this.opts.bin ?? "claude"}: ${r.spawnError}` };
    if (r.cancelled) return { ...meta, ok: false, text: r.stdout.slice(-2000), failure: "cancelled", error: "cancelled" };
    if (r.timedOut) return { ...meta, ok: false, text: r.stdout.slice(-2000), failure: "timeout", error: `exceeded ${Math.round(req.timeoutMs / 1000)}s` };
    return { ...parseClaudeOutput(r), logFile: req.logFile };
  }
}
