import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The patience is the tab's: a fresh module per test starts its clock again.
// Fake timers are switched on after the import: a module graph loaded under them can stall.
async function load() {
  vi.useRealTimers();
  vi.resetModules();
  const mod = await import("./readings");
  vi.useFakeTimers();
  return mod;
}

// A fresh import of the readings module graph can be slow on a busy machine.
describe("usePatienceForRequests", { timeout: 20_000 }, () => {
  afterEach(() => vi.useRealTimers());

  it("waits while the requests load, and stops waiting after REQUESTS_PATIENCE", async () => {
    const { usePatienceForRequests, REQUESTS_PATIENCE } = await load();
    const { result } = renderHook(({ loading }) => usePatienceForRequests(loading), { initialProps: { loading: true } });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(REQUESTS_PATIENCE + 10));
    expect(result.current).toBe(false);
  });

  it("does not wait once the requests have answered", async () => {
    const { usePatienceForRequests } = await load();
    const { result, rerender } = renderHook(({ loading }) => usePatienceForRequests(loading), { initialProps: { loading: true } });
    expect(result.current).toBe(true);
    rerender({ loading: false });
    expect(result.current).toBe(false);
  });

  it("is one clock for the tab: a count mounted later stops waiting at the same moment", async () => {
    const { usePatienceForRequests, REQUESTS_PATIENCE } = await load();
    const first = renderHook(() => usePatienceForRequests(true));
    act(() => vi.advanceTimersByTime(REQUESTS_PATIENCE - 500));
    const later = renderHook(() => usePatienceForRequests(true));
    expect(later.result.current).toBe(true);
    act(() => vi.advanceTimersByTime(510));
    expect(first.result.current).toBe(false);
    expect(later.result.current).toBe(false);
  });

  it("a count mounted after the patience ran out does not wait at all", async () => {
    const { usePatienceForRequests, REQUESTS_PATIENCE } = await load();
    renderHook(() => usePatienceForRequests(true));
    act(() => vi.advanceTimersByTime(REQUESTS_PATIENCE + 100));
    const late = renderHook(() => usePatienceForRequests(true));
    expect(late.result.current).toBe(false);
  });

  it("starts counting when the requests are first read, not when the page opened", async () => {
    const { usePatienceForRequests, REQUESTS_PATIENCE } = await load();
    const { result, rerender } = renderHook(({ loading }) => usePatienceForRequests(loading), { initialProps: { loading: false } });
    act(() => vi.advanceTimersByTime(REQUESTS_PATIENCE * 2));
    rerender({ loading: true });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(REQUESTS_PATIENCE + 10));
    expect(result.current).toBe(false);
  });
});
