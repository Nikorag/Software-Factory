import { describe, expect, it } from "vitest";
import { ENDPOINT_INSTANCE, FALLBACK_PLUGINS, fieldsFor, instanceOfRoute, instanceOptions, pluginOfInstance, routeFor, settingsFrom, TASKS, type PluginInfo } from "./tasks";

const info = (id: string): PluginInfo => FALLBACK_PLUGINS.plugins.find((p) => p.id === id)!;

describe("route <-> plugin instance", () => {
  it("reads both route shapes: a plugin instance, and the legacy provider", () => {
    expect(instanceOfRoute({ plugin: "gpt", model: "m" })).toBe("gpt");
    expect(instanceOfRoute({ provider: "anthropic", model: "haiku" })).toBe("claude-code");
    expect(instanceOfRoute({ provider: "local", model: "q" })).toBe("local");
    expect(instanceOfRoute({ provider: "local", model: "q", baseUrl: "https://x.test/v1" })).toBe(ENDPOINT_INSTANCE);
    expect(routeFor("gpt", "m")).toEqual({ plugin: "gpt", model: "m" });
  });
  it("offers only available instances whose plugin can do the step", () => {
    expect(instanceOptions(FALLBACK_PLUGINS, true).map((i) => i.id)).toEqual(["claude-code"]);
    expect(instanceOptions(FALLBACK_PLUGINS, false).map((i) => i.id)).toEqual(["claude-code", "local"]);
    const down = { ...FALLBACK_PLUGINS, plugins: FALLBACK_PLUGINS.plugins.map((p) => (p.id === "claude-code" ? { ...p, state: "incompatible" as const } : p)) };
    expect(instanceOptions(down, false).map((i) => i.id)).toEqual(["local"]);
    expect(pluginOfInstance(FALLBACK_PLUGINS, "local")?.id).toBe("openai-compatible");
  });
  it("marks the steps that need file and shell tools", () => {
    expect(TASKS.filter((t) => t.tools).map((t) => t.id).sort()).toEqual(["implementation", "prompt_generation", "specification"]);
  });
});

describe("plugin settings fields", () => {
  it("shows only what the plugin supports, derived from its capabilities", () => {
    expect(fieldsFor(info("claude-code"))).toEqual([]);
    expect(fieldsFor(info("openai-compatible"))).toEqual(["baseUrl", "apiKeyEnv"]);
    expect(fieldsFor(undefined)).toEqual([]);
  });
  it("sends only the shown, non-blank fields (the key variable's NAME, never a key)", () => {
    expect(settingsFrom(info("openai-compatible"), { baseUrl: " http://127.0.0.1:1234/v1 ", apiKeyEnv: "" })).toEqual({ baseUrl: "http://127.0.0.1:1234/v1" });
    expect(settingsFrom(info("claude-code"), { baseUrl: "http://x", apiKeyEnv: "K" })).toEqual({});
  });
});
