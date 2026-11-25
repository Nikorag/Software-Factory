import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateProfile, addProfile, getProfile, listProfiles, ProfileError, removeProfile } from "../src/config/profiles.js";
import { loadConfig } from "../src/config/load.js";
import { tmp } from "./helpers/git-fixture.js";

const SAVED = { ...process.env };
afterEach(() => { for (const k of ["FACTORY_ROOT", "FACTORY_HOME", "FACTORY_PROFILE"]) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });
const root = () => { const r = tmp(); mkdirSync(join(r, "config"), { recursive: true }); writeFileSync(join(r, "config", "factory.yaml"), "server: { port: 4790 }\n"); return r; };

describe("profiles", () => {
  it("always has the default profile, which IS the existing install (no migration)", () => {
    const r = root();
    expect(listProfiles(r)).toEqual([{ name: "default", home: r, port: 4790 }]);
    expect(JSON.parse(readFileSync(join(r, "profiles.json"), "utf8")).profiles).toHaveLength(1); // the desktop app reads this
  });
  it("creates an isolated profile: own home, own port, own Linear key (keychain entry AND env var), seeded config", () => {
    const r = root();
    const a = addProfile("work", r), b = addProfile("client-2", r);
    expect(a).toMatchObject({ name: "work", home: join(r, "profiles", "work"), port: 4781 });
    expect(b.port).toBe(4782);                                                       // never two profiles on one port
    const linear = readFileSync(join(a.home, "config", "linear.yaml"), "utf8");
    expect(linear).toContain("keychainService: software-factory-linear-work");
    expect(linear).toContain("apiKeyEnv: LINEAR_API_KEY_WORK");                       // a LINEAR_API_KEY exported in the shell cannot leak in
    expect(readFileSync(join(b.home, "config", "linear.yaml"), "utf8")).toContain("LINEAR_API_KEY_CLIENT_2");
    expect(existsSync(join(a.home, "config", "models.yaml"))).toBe(true);
    expect(readFileSync(join(a.home, "config", "projects.yaml"), "utf8")).not.toMatch(/Zonto|Nikorag/); // starts empty
    expect(listProfiles(r).map((p) => p.name)).toEqual(["default", "work", "client-2"]);
  });
  it("rejects bad or duplicate names and protects the default", () => {
    const r = root();
    for (const bad of ["", "Work", "a b", "-x", "../evil", "x".repeat(40), "default"]) expect(() => addProfile(bad, r), bad).toThrow(ProfileError);
    addProfile("work", r);
    expect(() => addProfile("work", r)).toThrow(/already exists/);
    expect(() => removeProfile("default", r)).toThrow(/cannot be removed/);
    expect(() => getProfile("nope", r)).toThrow(/no such profile/);
  });
  it("removing forgets it but leaves its data on disk", () => {
    const r = root();
    const p = addProfile("work", r);
    removeProfile("work", r);
    expect(listProfiles(r).map((x) => x.name)).toEqual(["default"]);
    expect(existsSync(join(p.home, "config", "factory.yaml"))).toBe(true);
    expect(addProfile("work", r).port).toBe(4781);                                   // the port is free again
  });
  it("activating a profile makes config, data dir, port and keychain service all that profile's", () => {
    const r = root();
    const work = addProfile("work", r);
    delete process.env.FACTORY_CONFIG_DIR;
    activateProfile("work", r);
    const c = loadConfig();
    expect(c.factory.server.port).toBe(4781);
    expect(c.factory.dataDir).toBe(work.home);
    expect(c.linear.keychainService).toBe("software-factory-linear-work");
    expect(c.projects.projects).toEqual([]);                                          // separate projects
    activateProfile("default", r);
    expect(loadConfig().factory.server.port).toBe(4790);
  });
});
