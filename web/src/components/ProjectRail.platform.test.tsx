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
  render(
    <MemoryRouter>
      <ProjectRail open={false} overview={null} projects={[]} jobs={[]} projectId={null} jobId={null} stop={false} paused={false}
        profiles={{ current: "a", profiles: [{ name: "a", current: true, running: true, url: "/" }, { name: "b", current: false, running: true, url: "/b" }] } as never} />
    </MemoryRouter>,
  );
  return screen.getByText("Software Factory").parentElement!;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ProjectRail top row in the desktop app", () => {
  it("reserves the window-controls area on the right on Windows/Linux and stays a drag region", async () => {
    const header = await renderRail(UA.overlay);
    expect(header.className).toContain("md:pr-36");
    expect(header.className).toContain("pl-4");
    expect(header.className).toContain("app-drag");
    expect(screen.getByLabelText("profile")).toBeTruthy();
  });

  it("keeps the traffic-light padding and adds no right reserve on macOS", async () => {
    const header = await renderRail(UA.mac);
    expect(header.className).toContain("pl-[84px]");
    expect(header.className).not.toContain("md:pr-36");
  });
});
