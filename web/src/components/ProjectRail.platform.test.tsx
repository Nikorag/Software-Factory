import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const UA = {
  overlay: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Electron/30.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Electron/30.0.0 Safari/537.36",
};

// The platform flags are computed at module load, so stub the UA and re-import the rail fresh.
async function renderRail(ua: string) {
  vi.resetModules();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  const { ProjectRail } = await import("@/components/ProjectRail");
  const platform = await import("@/lib/platform"); // same module instance the rail just loaded
  render(
    <MemoryRouter>
      <ProjectRail open={false} overview={null} projects={[]} jobs={[]} projectId={null} jobId={null} stop={false} paused={false}
        profiles={{ current: "a", profiles: [{ name: "a", current: true, running: true, url: "/" }, { name: "b", current: false, running: true, url: "/b" }] } as never} />
    </MemoryRouter>,
  );
  return { header: screen.getByText("Software Factory").parentElement!, platform };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ProjectRail top row in the desktop app", () => {
  // The rail is a 264px column on the left; the Windows/Linux window buttons are top-right and Shell's header already reserves that corner.
  // Reserving 144px here would only squeeze the title, so the rail header must not carry a right reserve.
  it("adds no right reserve to the rail header on Windows/Linux and stays a drag region", async () => {
    const { header, platform } = await renderRail(UA.overlay);
    expect(platform.inElectron).toBe(true);
    expect(platform.electronOverlay).toBe(true);
    expect(platform.electronMac).toBe(false);
    expect(header.className).not.toContain("md:pr-36");
    expect(header.className).toContain("pl-4");
    expect(header.className).toContain("app-drag");
    expect(screen.getByLabelText("profile")).toBeTruthy();
  });

  it("keeps the traffic-light padding and adds no right reserve on macOS", async () => {
    const { header, platform } = await renderRail(UA.mac);
    expect(platform.electronMac).toBe(true);
    expect(platform.electronOverlay).toBe(false);
    expect(header.className).toContain("pl-[84px]");
    expect(header.className).not.toContain("md:pr-36");
  });
});
