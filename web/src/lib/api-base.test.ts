import { afterEach, describe, expect, it, vi } from "vitest";
import { api, inHubMode, send } from "@/lib/api";

const setBase = (v: string | null) => { document.head.querySelectorAll('meta[name="factory-hub-base"]').forEach((m) => m.remove()); if (v !== null) { const m = document.createElement("meta"); m.name = "factory-hub-base"; m.content = v; document.head.append(m); } };
afterEach(() => { setBase(null); vi.restoreAllMocks(); });
const fetchMock = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

describe("hub base path", () => {
  it("is a no-op when served by the factory itself", async () => {
    setBase(""); const f = fetchMock(); await api("/api/overview"); await send("POST", "/api/jobs/1/cancel", {});
    expect(inHubMode()).toBe(false);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["/api/overview", "/api/jobs/1/cancel"]);
  });
  it("prefixes every call when served by the hub for one factory", async () => {
    setBase("/f/abc-123/"); const f = fetchMock(); await api("/api/overview"); await send("PUT", "/api/settings/tracker", { tracker: "linear" });
    expect(inHubMode()).toBe(true);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["/f/abc-123/api/overview", "/f/abc-123/api/settings/tracker"]);
  });
});
