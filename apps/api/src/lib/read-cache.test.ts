import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateReadCache, readCacheSize, readThrough } from "./read-cache.js";

/** A load that counts its calls and resolves when told to. */
function deferredLoad<T>() {
  let calls = 0;
  const pending: { resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  const load = () => {
    calls += 1;
    return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { load, calls: () => calls, pending };
}

describe("readThrough", () => {
  beforeEach(() => {
    vi.stubEnv("READ_CACHE_SECONDS", "30");
    invalidateReadCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    invalidateReadCache();
  });

  it("serves a second call from memory", async () => {
    const load = vi.fn(async () => ({ title: "Saltmere" }));

    const first = await readThrough("k", load);
    const second = await readThrough("k", load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("shares one load between concurrent misses", async () => {
    const { load, calls, pending } = deferredLoad<string>();

    const waiting = [readThrough("k", load), readThrough("k", load), readThrough("k", load)];
    pending[0]!.resolve("one answer");

    expect(await Promise.all(waiting)).toEqual(["one answer", "one answer", "one answer"]);
    expect(calls()).toBe(1);
  });

  it("does not keep a failure, so the next caller tries again", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce("found");

    await expect(readThrough("k", load)).rejects.toThrow("not found");
    expect(await readThrough("k", load)).toBe("found");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads again once the entry expires", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => Date.now());

    await readThrough("k", load);
    vi.advanceTimersByTime(29_000);
    await readThrough("k", load);
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await readThrough("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never stores a load that was in flight when the cache was cleared", async () => {
    const { load, calls, pending } = deferredLoad<string>();

    const before = readThrough("k", load);
    invalidateReadCache();
    pending[0]!.resolve("read before the write committed");
    await before;

    const after = readThrough("k", load);
    pending[1]!.resolve("read after it");

    expect(await after).toBe("read after it");
    expect(calls()).toBe(2);
  });

  it("keys entries apart", async () => {
    expect(await readThrough("a", async () => "a")).toBe("a");
    expect(await readThrough("b", async () => "b")).toBe("b");
    expect(readCacheSize()).toBe(2);
  });

  it("is off at zero seconds", async () => {
    vi.stubEnv("READ_CACHE_SECONDS", "0");
    const load = vi.fn(async () => "fresh");

    await readThrough("k", load);
    await readThrough("k", load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(readCacheSize()).toBe(0);
  });
});
