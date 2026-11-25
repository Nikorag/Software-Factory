import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandElectron } from "../src/service/branding.js";
import { tmp } from "./helpers/git-fixture.js";

/** A stand-in Electron.app bundle, and an exec that records what it was asked to do (writing the .icns that iconutil would). */
function world() {
  const root = tmp();
  const app = join(root, "dist", "Electron.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true }); mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Electron"), "bin"); writeFileSync(join(app, "Contents", "Info.plist"), "ORIGINAL-PLIST"); writeFileSync(join(app, "Contents", "Resources", "electron.icns"), "ORIGINAL-ICNS");
  const icon = join(root, "icon.png"); writeFileSync(icon, "icon-v1");
  const calls: string[] = [];
  const exec = (failOn?: string) => (file: string, args: string[]) => {
    const tool = file.split("/").pop()!;
    calls.push(`${tool} ${args.slice(0, 3).join(" ")}`.trim());
    if (tool === failOn) throw new Error(`${tool} failed`);
    if (tool === "iconutil") writeFileSync(args[args.indexOf("-o") + 1]!, "NEW-ICNS");
  };
  return { app, icon, bin: join(app, "Contents", "MacOS", "Electron"), calls, exec };
}

describe("branding the local Electron as Software Factory", () => {
  it("gives the app bundle the right name, id and icon, then re-signs it", () => {
    const w = world();
    expect(brandElectron(w.bin, w.icon, { exec: w.exec(), platform: "darwin" })).toEqual({ branded: true });
    expect(readFileSync(join(w.app, "Contents", "Resources", "electron.icns"), "utf8")).toBe("NEW-ICNS");
    const tools = w.calls.map((c) => c.split(" ")[0]);
    expect(tools.filter((t) => t === "sips")).toHaveLength(9);                                   // every size macOS wants
    expect(tools.indexOf("iconutil")).toBeGreaterThan(tools.lastIndexOf("sips"));
    expect(w.calls.filter((c) => c.startsWith("plutil")).map((c) => c.split(" ")[2])).toEqual(["CFBundleName", "CFBundleDisplayName", "CFBundleIdentifier"]);
    expect(tools.at(-1)).toBe("codesign");                                                       // signing is last, after every edit
    expect(existsSync(join(w.app, "..", ".software-factory-original", "Info.plist"))).toBe(true); // originals kept outside the bundle
  });
  it("does nothing the second time, and again only when the icon changes", () => {
    const w = world();
    brandElectron(w.bin, w.icon, { exec: w.exec(), platform: "darwin" });
    const first = w.calls.length;
    expect(brandElectron(w.bin, w.icon, { exec: w.exec(), platform: "darwin" })).toEqual({ branded: true });
    expect(w.calls.length).toBe(first);                                                          // no tool ran
    writeFileSync(w.icon, "icon-v2");
    brandElectron(w.bin, w.icon, { exec: w.exec(), platform: "darwin" });
    expect(w.calls.length).toBeGreaterThan(first);
  });
  it("puts everything back if a step fails, so the app can still start (it just says Electron)", () => {
    const w = world();
    const r = brandElectron(w.bin, w.icon, { exec: w.exec("plutil"), platform: "darwin" });
    expect(r.branded).toBe(false);
    expect(r.reason).toMatch(/plutil failed.*"Electron"/);
    expect(readFileSync(join(w.app, "Contents", "Info.plist"), "utf8")).toBe("ORIGINAL-PLIST");
    expect(readFileSync(join(w.app, "Contents", "Resources", "electron.icns"), "utf8")).toBe("ORIGINAL-ICNS");
    expect(existsSync(join(w.app, "Contents", "Resources", ".software-factory-brand"))).toBe(false);
    expect(w.calls.at(-1)).toMatch(/^codesign/);                                                 // re-signed after the restore
  });
  it("leaves other platforms and missing pieces alone", () => {
    const w = world();
    expect(brandElectron(w.bin, w.icon, { exec: w.exec(), platform: "linux" }).branded).toBe(false);
    expect(brandElectron(w.bin, join(w.app, "nope.png"), { exec: w.exec(), platform: "darwin" }).branded).toBe(false);
    expect(brandElectron(join(w.app, "..", "plain", "node"), w.icon, { exec: w.exec(), platform: "darwin" }).branded).toBe(false);
    expect(w.calls).toEqual([]);
  });
});
