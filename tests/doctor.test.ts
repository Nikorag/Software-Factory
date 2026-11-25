import { describe, expect, it } from "vitest";
import { checkLocalModels, checkLocalRoutes } from "../src/doctor/checks.js";
import { loadConfig } from "../src/config/load.js";

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

describe("checkLocalRoutes", () => {
  const cfg = () => loadConfig("config");
  it("warns while routes still hold the UNCONFIGURED placeholder", async () => {
    const r = await checkLocalRoutes(cfg(), respond(200, { data: [{ id: "qwen-a" }] }));
    expect(r.map((x) => x.status)).toEqual(["warn", "warn"]);
  });
  it("passes when the configured model is loaded and fails when it is not", async () => {
    const c = cfg();
    c.models.routes.classification.model = "qwen-a";
    c.models.routes.independent_review.model = "qwen-missing";
    const r = await checkLocalRoutes(c, respond(200, { data: [{ id: "qwen-a" }] }));
    expect(r.find((x) => x.name === "route classification")?.status).toBe("ok");
    expect(r.find((x) => x.name === "route independent_review")).toMatchObject({ status: "fail", detail: expect.stringContaining("qwen-a") });
  });
});
