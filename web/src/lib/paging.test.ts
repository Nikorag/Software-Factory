import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clampPage, usePaged } from "./paging";

const list = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("client-side paging of live lists", () => {
  it("stays on the page you are reading when a poll adds or removes rows", () => {
    const { result, rerender } = renderHook(({ items, key }) => usePaged(items, 10, key), { initialProps: { items: list(35), key: "" } });
    act(() => result.current.setPage(3));
    rerender({ items: list(36), key: "" }); // a new row arrived
    expect(result.current.page).toBe(3);
    rerender({ items: list(34), key: "" }); // one went away
    expect(result.current.page).toBe(3);
  });
  it("clamps when the list shrinks below the current page", () => {
    const { result, rerender } = renderHook(({ items }) => usePaged(items, 10, ""), { initialProps: { items: list(35) } });
    act(() => result.current.setPage(4));
    rerender({ items: list(15) });
    expect(result.current.page).toBe(2);
    expect(result.current.slice).toEqual(list(15).slice(10));
  });
  it("goes back to page 1 when the filter or page size changes", () => {
    const { result, rerender } = renderHook(({ items, key }) => usePaged(items, 10, key), { initialProps: { items: list(35), key: "" } });
    act(() => result.current.setPage(3));
    rerender({ items: list(35), key: "login" });
    expect(result.current.page).toBe(1);
    act(() => result.current.setPage(2));
    act(() => result.current.setPageSize(25));
    expect(result.current.page).toBe(1);
  });
  it("clampPage keeps a page within range", () => {
    expect(clampPage(5, 12, 10)).toBe(2); expect(clampPage(0, 12, 10)).toBe(1); expect(clampPage(3, 0, 10)).toBe(1);
  });
});
