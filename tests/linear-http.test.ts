import { describe, expect, it, vi } from "vitest";
import { createLinearClient, LinearApiError } from "../src/linear/client.js";

const KEY = "lin_api_SECRET_VALUE_123";
type Resp = { status?: number; body?: unknown; headers?: Record<string, string> };
const sequence = (...rs: (Resp | Error)[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = rs[Math.min(calls.length - 1, rs.length - 1)]!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
};
const client = (f: typeof fetch, sleep = vi.fn(async (_ms: number) => {})) => ({ c: createLinearClient({ apiKey: KEY, fetch: f, sleep, maxRetries: 3 }), sleep });

describe("Linear HTTP client", () => {
  it("sends the personal key as-is in Authorization (no Bearer) and POSTs GraphQL JSON", async () => {
    const { f, calls } = sequence({ body: { data: { viewer: { id: "1", name: "Me" } } } });
    expect(await client(f).c.viewer()).toEqual({ id: "1", name: "Me" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(KEY);
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(JSON.parse(calls[0]!.init.body as string).query).toContain("viewer");
  });
  it("does not retry auth failures and never leaks the key in errors", async () => {
    const { f, calls } = sequence({ status: 401, body: { errors: [{ message: "bad", extensions: { code: "AUTHENTICATION_ERROR" } }] } });
    const err = await client(f).c.viewer().catch((e) => e);
    expect(err).toBeInstanceOf(LinearApiError);
    expect(err.retryable).toBe(false);
    expect(String(err.message) + JSON.stringify(err)).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });
  it("retries rate limits (HTTP 429 and GraphQL RATELIMITED), honouring the reset header", async () => {
    const reset = String(Date.now() + 2000);
    const { f, calls } = sequence(
      { status: 429, headers: { "x-ratelimit-requests-reset": reset } },
      { status: 400, body: { errors: [{ message: "slow", extensions: { code: "RATELIMITED" } }] } },
      { body: { data: { viewer: { id: "1", name: "Me" } } } },
    );
    const { c, sleep } = client(f);
    await c.viewer();
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThan(1500);
  });
  it("retries 5xx and network errors, then gives up with a retryable error", async () => {
    const { f, calls } = sequence(new Error("ECONNRESET"), { status: 502 }, { status: 503 }, { status: 503 });
    const err = await client(f).c.viewer().catch((e) => e);
    expect(calls).toHaveLength(4);
    expect(err.retryable).toBe(true);
  });
  it("fails fast on GraphQL errors (non-retryable)", async () => {
    const { f, calls } = sequence({ status: 400, body: { errors: [{ message: "Field x doesn't exist" }] } });
    const err = await client(f).c.viewer().catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("doesn't exist");
    expect(calls).toHaveLength(1);
  });
  it("builds the issue filter from team, status, label and optional project; paginates", async () => {
    const node = (n: number) => ({ id: `i${n}`, identifier: `E-${n}`, title: "t", description: null, url: "u", state: { id: "s", name: "Ready for specification", type: "unstarted" }, team: { id: "t", key: "ENG", name: "E" }, project: null, labels: { nodes: [{ id: "l", name: "factory:enabled" }] } });
    const { f, calls } = sequence(
      { body: { data: { issues: { nodes: [node(1)], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } },
      { body: { data: { issues: { nodes: [node(2)], pageInfo: { hasNextPage: false, endCursor: null } } } } },
    );
    const out = await client(f).c.listIssues({ teamKey: "ENG", projectId: "p1", stateName: "Ready for specification", labelName: "factory:enabled" });
    expect(out.map((i) => i.identifier)).toEqual(["E-1", "E-2"]);
    const v = JSON.parse(calls[0]!.init.body as string).variables;
    expect(v.filter).toEqual({ team: { key: { eq: "ENG" } }, state: { name: { eq: "Ready for specification" } }, labels: { some: { name: { eq: "factory:enabled" } } }, project: { id: { eq: "p1" } } });
    expect(JSON.parse(calls[1]!.init.body as string).variables.after).toBe("c1");
  });
  it("treats success:false mutations as failures and passes the client comment id", async () => {
    const { f, calls } = sequence({ body: { data: { commentCreate: { success: false } } } });
    await expect(client(f).c.createComment("i", "hi", "uuid-1")).rejects.toThrow(/reported failure/);
    expect(JSON.parse(calls[0]!.init.body as string).variables.input).toEqual({ issueId: "i", body: "hi", id: "uuid-1" });
  });
  it("includes workspace labels and the team's own, but not other teams'", async () => {
    const n = (id: string, team: string | null) => ({ id, name: id, team: team ? { id: team } : null });
    const { f } = sequence({ body: { data: { issueLabels: { nodes: [n("ws", null), n("mine", "t1"), n("other", "t2")], pageInfo: { hasNextPage: false } } } } });
    expect((await client(f).c.labels("t1")).map((l) => l.id)).toEqual(["ws", "mine"]);
  });
});
