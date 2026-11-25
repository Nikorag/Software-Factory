import { describe, expect, it } from "vitest";
import { checkLocalModels } from "../src/doctor/checks.js";

const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("checkLocalModels", () => {
  it("lists models the server reports", async () => {
    const [r] = await checkLocalModels("http://x/v1", respond(200, { data: [{ id: "qwen-a" }, { id: "qwen-b" }] }));
    expect(r).toMatchObject({ status: "ok", detail: "qwen-a, qwen-b" });
  });
  it("warns when the server has no models", async () => {
    const [r] = await checkLocalModels("http://x/v1", respond(200, { data: [] }));
    expect(r?.status).toBe("warn");
  });
  it("fails on HTTP errors and unreachable servers", async () => {
    expect((await checkLocalModels("http://x/v1", respond(404, {})))[0]?.status).toBe("fail");
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await checkLocalModels("http://x/v1", down))[0]?.status).toBe("fail");
  });
});
