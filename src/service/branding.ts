import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const APP_NAME = "Software Factory";
export const APP_ID = "com.software-factory.app";
export type Exec = (file: string, args: string[]) => void;
const defaultExec: Exec = (file, args) => { execFileSync(file, args, { stdio: "ignore", timeout: 120_000 }); };

/** macOS sizes for an .iconset: [file, pixels]. 512@2x is omitted: the source is 512px, and upscaling adds nothing. */
const ICONSET: [string, number][] = [["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64], ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512], ["icon_512x512.png", 512]];

/**
 * Electron run from node_modules is "Electron" in the Dock and menu bar, with Electron's icon, because those come from the app bundle's
 * Info.plist and .icns, not from the code. This gives the local copy the app's own name and icon: it edits Info.plist, swaps the icon,
 * and re-signs the bundle ad hoc (editing invalidates the signature, and an invalid one will not launch on Apple silicon). It is idempotent
 * (a marker records what was applied) and safe: the originals are saved outside the bundle and restored if any step fails, so the worst
 * case is the plain "Electron" name. Nothing is packaged or notarised: this only touches the copy of Electron the factory installed.
 */
export function brandElectron(electronBin: string, icon: string, o: { exec?: Exec; name?: string; id?: string; platform?: string } = {}): { branded: boolean; reason?: string } {
  if ((o.platform ?? process.platform) !== "darwin") return { branded: false, reason: "only macOS shows the app bundle's name and icon" };
  const exec = o.exec ?? defaultExec, name = o.name ?? APP_NAME, id = o.id ?? APP_ID;
  const app = dirname(dirname(dirname(electronBin)));
  if (!app.endsWith(".app") || !existsSync(icon)) return { branded: false, reason: "no app bundle or icon to work with" };
  const plist = join(app, "Contents", "Info.plist"), icns = join(app, "Contents", "Resources", "electron.icns"), marker = join(app, "Contents", "Resources", ".software-factory-brand");
  const stamp = createHash("sha256").update(`${name}|${id}|`).update(readFileSync(icon)).digest("hex");
  if (existsSync(marker) && readFileSync(marker, "utf8") === stamp) return { branded: true };

  const orig = join(dirname(app), ".software-factory-original");
  mkdirSync(orig, { recursive: true });
  if (!existsSync(join(orig, "Info.plist"))) { copyFileSync(plist, join(orig, "Info.plist")); copyFileSync(icns, join(orig, "electron.icns")); }
  const work = mkdtempSync(join(tmpdir(), "factory-icon-"));
  try {
    const set = join(work, "icon.iconset");
    mkdirSync(set);
    for (const [file, px] of ICONSET) exec("/usr/bin/sips", ["-z", String(px), String(px), icon, "--out", join(set, file)]);
    exec("/usr/bin/iconutil", ["-c", "icns", set, "-o", join(work, "app.icns")]);
    copyFileSync(join(work, "app.icns"), icns);
    for (const [key, value] of [["CFBundleName", name], ["CFBundleDisplayName", name], ["CFBundleIdentifier", id]] as const) exec("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    writeFileSync(marker, stamp); // before signing, so the signature seals it
    exec("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
    return { branded: true };
  } catch (e) {
    try { copyFileSync(join(orig, "Info.plist"), plist); copyFileSync(join(orig, "electron.icns"), icns); rmSync(marker, { force: true }); exec("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]); } catch { /* leave it: the run below will say if it cannot start */ }
    return { branded: false, reason: `could not rename the app (${(e as Error).message.split("\n")[0]}); it will show as "Electron"` };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
