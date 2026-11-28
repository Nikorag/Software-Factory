import type { Agent, AgentRequest, AgentResult } from "./types.js";

export class LocalModelError extends Error {
  constructor(message: string, readonly kind: "unreachable" | "not_configured" | "http" | "invalid_output") {
    super(message);
    this.name = "LocalModelError";
  }
}

export interface LocalModelOptions {
  baseUrl: string; fetch?: typeof fetch;
  /** NAME of the environment variable holding a bearer token for a hosted endpoint. Read per request; the value is never logged or stored. */
  apiKeyEnv?: string; env?: NodeJS.ProcessEnv;
  /** How errors name the backend (default "local model"; the OpenAI plugin says "OpenAI API"). */
  label?: string;
}

/** `<think>…</think>` blocks (Qwen-style reasoning) are not part of the answer. */
export const stripReasoning = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

/** Pulls a JSON value out of a reply that may be fenced or surrounded by prose. */
export function extractJson(text: string): unknown {
  const t = stripReasoning(text);
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]!.trim());
  for (const candidate of [t, ...fenced]) {
    try { return JSON.parse(candidate); } catch { /* try balanced scan */ }
    for (let i = 0; i < candidate.length; i++) {
      const open = candidate[i];
      if (open !== "{" && open !== "[") continue;
      const close = open === "{" ? "}" : "]";
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < candidate.length; j++) {
        const c = candidate[j]!;
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === open) depth++;
        else if (c === close && --depth === 0) {
          try { return JSON.parse(candidate.slice(i, j + 1)); } catch { break; }
        }
      }
    }
  }
  throw new LocalModelError("reply contained no parseable JSON", "invalid_output");
}

/**
 * Client for an OpenAI-compatible chat endpoint (LM Studio, llama.cpp, Ollama...).
 * `factory doctor` checks that it is reachable. Strictly sequential: one request at a time, because local
 * inference cannot share unified memory in parallel. Read-only by construction: it has no tools.
 */
export class LocalModelClient implements Agent {
  readonly provider = "local" as const;
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private active = false;
  private readonly doFetch: typeof fetch;

  private readonly label: string;

  constructor(private readonly o: LocalModelOptions) { this.doFetch = o.fetch ?? fetch; this.label = o.label ?? "local model"; }

  /** Request headers; `undefined` when a key is configured but its variable is not set. */
  private headers(): Record<string, string> | undefined {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (!this.o.apiKeyEnv) return h;
    const key = (this.o.env ?? process.env)[this.o.apiKeyEnv];
    if (!key) return undefined;
    return { ...h, Authorization: `Bearer ${key}` };
  }

  status() { return { active: this.active, queued: this.waiting }; }

  async listModels(timeoutMs = 5000): Promise<string[]> {
    try {
      const res = await this.doFetch(`${this.o.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new LocalModelError(`GET /models -> HTTP ${res.status}`, "http");
      return ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    } catch (e) {
      if (e instanceof LocalModelError) throw e;
      throw new LocalModelError(`${this.label} server unreachable at ${this.o.baseUrl}`, "unreachable");
    }
  }

  run(req: AgentRequest): Promise<AgentResult> {
    if (req.profile !== "read-only") {
      return Promise.resolve(this.fail("error", `the ${this.label} has no tools and may only serve read-only requests`, 0));
    }
    this.waiting++;
    const job = this.tail.then(async () => {
      this.waiting--;
      if (req.signal?.aborted) return this.fail("cancelled", "cancelled before start", 0);
      this.active = true;
      try { return await this.execute(req); } finally { this.active = false; }
    });
    this.tail = job.catch(() => {});
    return job;
  }

  private fail(failure: NonNullable<AgentResult["failure"]>, error: string, durationMs: number): AgentResult {
    return { ok: false, text: "", denials: [], exitCode: null, durationMs, failure, error };
  }

  private async chat(req: AgentRequest, messages: { role: string; content: string }[], useSchema: boolean, signal: AbortSignal) {
    const body: Record<string, unknown> = { model: req.model, messages, stream: false, temperature: 0.1 };
    if (req.jsonSchema && useSchema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: req.jsonSchema } };
    const res = await this.doFetch(`${this.o.baseUrl}/chat/completions`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), signal,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  }

  private async execute(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    const model = req.model;
    if (!model || /^UNCONFIGURED/i.test(model)) {
      return this.fail("error", "no local model configured: set a real model id in config/models.yaml (see `factory doctor`)", 0);
    }
    if (!this.headers()) return this.fail("error", `the API key environment variable ${this.o.apiKeyEnv} is not set`, 0);
    const signal = AbortSignal.any([AbortSignal.timeout(req.timeoutMs), ...(req.signal ? [req.signal] : [])]);
    const messages: { role: string; content: string }[] = [
      ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
      { role: "user", content: req.prompt },
    ];
    let useSchema = Boolean(req.jsonSchema);
    let usage: Record<string, unknown> | undefined;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let r = await this.chat(req, messages, useSchema, signal);
        if (r.status === 400 && useSchema && /response_format|json_schema/i.test(r.text)) {
          // Server does not support schema-constrained output: fall back to instructing the model in the prompt.
          useSchema = false;
          messages.push({ role: "user", content: `Respond with ONLY JSON matching this JSON Schema, no prose:\n${JSON.stringify(req.jsonSchema)}` });
          r = await this.chat(req, messages, false, signal);
        }
        if (!r.ok) {
          const transient = r.status >= 500 || r.status === 429;
          return { ...this.fail(transient ? "transient" : "error", `${this.label} HTTP ${r.status}: ${r.text.slice(0, 300)}`, Date.now() - started) };
        }
        const data = JSON.parse(r.text) as { choices?: { message?: { content?: string } }[]; usage?: Record<string, unknown> };
        usage = data.usage;
        const content = data.choices?.[0]?.message?.content ?? "";
        const text = stripReasoning(content);
        const base = { denials: [], exitCode: 0, durationMs: Date.now() - started, usage, text };
        if (!req.jsonSchema) return { ...base, ok: true };
        try { return { ...base, ok: true, structured: extractJson(content) }; }
        catch {
          if (attempt === 2) return { ...base, ok: false, failure: "invalid_output", error: `${this.label} did not return valid JSON after retries` };
          messages.push({ role: "assistant", content: text }, { role: "user", content: "That was not valid JSON for the schema. Reply with ONLY the JSON object." });
        }
      }
      return this.fail("invalid_output", "exhausted attempts", Date.now() - started);
    } catch (e) {
      const d = Date.now() - started;
      if (req.signal?.aborted) return this.fail("cancelled", "cancelled", d);
      if (signal.aborted) return this.fail("timeout", `exceeded ${Math.round(req.timeoutMs / 1000)}s`, d);
      return this.fail("transient", `${this.label} server unreachable at ${this.o.baseUrl}:${(e as Error).message}`, d);
    }
  }
}
