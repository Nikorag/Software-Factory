import { describe, expect, it } from "vitest";
import { fixtureConfig } from "./helpers/config.js";
import { checkLocalModels, checkLocalRoutes, reviewerIndependence } from "../src/doctor/checks.js";

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

describe("checkLocalRoutes / local checks", () => {
  const withLocal = (cls: string, rev: string) => {
    const c = fixtureConfig();
    c.models.routes.classification = { provider: "local", model: cls };
    c.models.routes.independent_review = { provider: "local", model: rev };
    return c;
  };
  it("returns nothing when no route uses a local model (the default: Claude only)", async () => {
    expect(await checkLocalRoutes(fixtureConfig(), respond(200, { data: [] }))).toEqual([]);
  });
  it("warns while a local route still holds the UNCONFIGURED placeholder", async () => {
    const r = await checkLocalRoutes(withLocal("UNCONFIGURED-QWEN", "UNCONFIGURED-QWEN"), respond(200, { data: [{ id: "qwen-a" }] }));
    expect(r.map((x) => x.status)).toEqual(["warn", "warn"]);
  });
  it("passes when the configured local model is loaded and fails when it is not", async () => {
    const r = await checkLocalRoutes(withLocal("qwen-a", "qwen-missing"), respond(200, { data: [{ id: "qwen-a" }] }));
    expect(r.find((x) => x.name === "route classification")?.status).toBe("ok");
    expect(r.find((x) => x.name === "route independent_review")).toMatchObject({ status: "fail", detail: expect.stringContaining("qwen-a") });
  });
});

describe("reviewerIndependence", () => {
  it("is ok when the reviewer is a different model from the author (shipped config: haiku vs default)", () => {
    const [r] = reviewerIndependence(fixtureConfig());
    expect(r).toMatchObject({ status: "ok" });
    expect(r!.detail).toContain("haiku");
  });
  it("warns when the reviewer is the same model as the author", () => {
    const c = fixtureConfig();
    c.models.routes.independent_review = { ...c.models.routes.specification };
    expect(reviewerIndependence(c)[0]).toMatchObject({ status: "warn", detail: expect.stringContaining("same model") });
  });
});
