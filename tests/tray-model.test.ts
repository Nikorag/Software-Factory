import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { summarise } = createRequire(import.meta.url)("../desktop/tray-model.cjs") as { summarise: (p: { name: string; up: boolean; running?: number; queued?: number; waiting?: number }[]) => { title: string; tooltip: string; anyUp: boolean; allUp: boolean; running: number; lines: { label: string; name: string; up: boolean }[] } };

describe("menu bar icon status", () => {
  it("shows how many jobs are running next to the icon, and says it in the tooltip", () => {
    const m = summarise([{ name: "home", up: true, running: 2, queued: 1, waiting: 3 }]);
    expect(m.title).toBe(" 2");
    expect(m.tooltip).toBe("Software Factory: 2 jobs running, 1 queued, 3 waiting");
    expect(summarise([{ name: "home", up: true, running: 1 }]).tooltip).toBe("Software Factory: 1 job running");
  });
  it("adds up every running profile, and ignores one that is stopped", () => {
    const m = summarise([{ name: "home", up: true, running: 1 }, { name: "work", up: true, running: 2, waiting: 1 }, { name: "old", up: false, running: 9 }]);
    expect(m.running).toBe(3); expect(m.allUp).toBe(false); expect(m.anyUp).toBe(true);
    expect(m.lines.map((l) => l.label)).toEqual(["● home: 1 running", "● work: 2 running, 1 waiting", "○ old: stopped"]);
  });
  it("nothing running: blank if idle, a dot and a count if something is waiting for a person, 'stopped' if the factory is off", () => {
    expect(summarise([{ name: "home", up: true }]).title).toBe("");
    expect(summarise([{ name: "home", up: true }]).tooltip).toBe("Software Factory: idle");
    expect(summarise([{ name: "home", up: true, waiting: 2 }]).title).toBe(" ·2");
    const off = summarise([{ name: "home", up: false }]);
    expect(off).toMatchObject({ anyUp: false, title: "", tooltip: "Software Factory: stopped" });
    expect(off.lines[0]!.label).toBe("○ home: stopped");
  });
});
