import { afterEach, describe, expect, it } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { FlowChart } from "./FlowChart";
import type { Flow } from "@/lib/pipeline";

const flow = { mode: "speckit", state: {}, attempts: {}, duration: {}, skipped: new Set(), loopsUsed: new Set() } as unknown as Flow;
const setup = () => {
  render(<FlowChart flow={flow} selected={null} onSelect={() => {}} />);
  const canvas = screen.getByTestId("flow-canvas");
  return { canvas, inner: canvas.firstElementChild as HTMLElement };
};
const wheel = (el: HTMLElement, init: WheelEventInit) => { const e = createEvent.wheel(el, { deltaY: -100, cancelable: true, ...init }); fireEvent(el, e); return e; };
const scale = (inner: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(inner.style.transform)![1]);

afterEach(cleanup);

describe("FlowChart scrolling and zoom", () => {
  it("leaves a plain wheel scroll alone so the page scrolls", () => {
    const { canvas, inner } = setup();
    const before = scale(inner);
    expect(wheel(canvas, {}).defaultPrevented).toBe(false);
    expect(scale(inner)).toBe(before);
  });
  it("does not trap scroll chaining or desktop touch scrolling", () => {
    const { canvas } = setup();
    expect(canvas.className).not.toMatch(/overscroll-contain/);
    expect(canvas.className).not.toMatch(/(^|\s)touch-none/);
  });
  it("zooms on ctrl or meta wheel and prevents the browser's own zoom", () => {
    for (const key of ["ctrlKey", "metaKey"] as const) {
      const { canvas, inner } = setup();
      const e = wheel(canvas, { [key]: true });
      expect(e.defaultPrevented).toBe(true);
      expect(scale(inner)).toBeGreaterThan(1);
      cleanup();
    }
  });
  it("clamps zoom to fit and to the maximum", () => {
    const { canvas, inner } = setup();
    wheel(canvas, { ctrlKey: true, deltaY: -5000 });
    expect(scale(inner)).toBe(3);
    wheel(canvas, { ctrlKey: true, deltaY: 5000 });
    expect(scale(inner)).toBe(1);
  });
  it("zoom buttons work", () => {
    const { inner } = setup();
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(scale(inner)).toBeCloseTo(1.4);
    fireEvent.click(screen.getByLabelText("Zoom out"));
    expect(scale(inner)).toBe(1);
  });
  it("does not capture the pointer for a drag while fitted to width", () => {
    const { canvas } = setup();
    let captured = 0; canvas.setPointerCapture = () => { captured++; };
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 140 });
    expect(captured).toBe(0);
  });
  it("a drag that starts and ends on a step does not select it, even while fitted", () => {
    const picked: string[] = [];
    render(<FlowChart flow={flow} selected={null} onSelect={(id) => picked.push(id)} />);
    const step = screen.getAllByRole("button").find((b) => b.getAttribute("aria-label")?.includes(":"))!;
    fireEvent.pointerDown(step, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(step, { pointerId: 1, clientX: 160, clientY: 100 });
    fireEvent.pointerUp(step, { pointerId: 1, clientX: 160, clientY: 100 });
    fireEvent.click(step);
    expect(picked).toEqual([]);
  });
  it("a fitted mouse drag released outside the canvas does not leave a gesture that pans on hover", () => {
    const { canvas, inner } = setup();
    let captured = 0; canvas.setPointerCapture = () => { captured++; };
    const mouse = { pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(canvas, { ...mouse, buttons: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(canvas, { ...mouse, buttons: 1, clientX: 360, clientY: 100 }); // button then released elsewhere: no pointerup arrives
    wheel(canvas, { ctrlKey: true });
    const before = inner.style.transform;
    fireEvent.pointerMove(canvas, { ...mouse, buttons: 0, clientX: 200, clientY: 100 });
    expect(inner.style.transform).toBe(before);
    expect(captured).toBe(0);
  });
  it("pans on drag when zoomed in", () => {
    const { canvas, inner } = setup();
    let captured = 0; canvas.setPointerCapture = () => { captured++; };
    fireEvent.click(screen.getByLabelText("Zoom in"));
    const before = inner.style.transform;
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 200, clientY: 100 });
    expect(captured).toBe(1);
    expect(inner.style.transform).not.toBe(before);
  });
});
