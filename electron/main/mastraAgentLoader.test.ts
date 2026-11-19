// MP-3c (DR-MP3-17): the lazy loader of the third bundle. A closed gate never
// loads; the env pin is applied once, right before the read, never earlier;
// concurrent callers share one load; a failure is neither cached nor retried.
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createMastraAgentLoader,
  MastraAgentLoadError,
} from "./mastraAgentLoader.js";

const RUNTIME = {
  createMastraAgentRuntime: () => ({ runTurn: async () => {} }),
};

describe("mastraAgentLoader", () => {
  it("a closed gate loads nothing: the env is not touched and the file is not read", async () => {
    const applyEnv = vi.fn();
    const requireModule = vi.fn();
    const loader = createMastraAgentLoader({
      isOpen: () => false,
      applyEnv,
      requireModule,
    });
    await expect(loader.load()).rejects.toMatchObject({ code: "gate-closed" });
    expect(applyEnv).not.toHaveBeenCalled();
    expect(requireModule).not.toHaveBeenCalled();
    expect(loader.loaded).toBe(false);
  });

  it("applies the env pin immediately before the read, then reads <bundleDir>/mastra-agent.cjs once", async () => {
    const order: string[] = [];
    const loader = createMastraAgentLoader({
      isOpen: () => true,
      applyEnv: () => order.push("apply"),
      requireModule: (file) => {
        order.push(`require ${path.basename(file)} in ${path.dirname(file)}`);
        return RUNTIME;
      },
      bundleDir: "/app/dist-electron",
    });
    expect(order).toEqual([]);
    await expect(loader.load()).resolves.toBe(RUNTIME);
    expect(order).toEqual([
      "apply",
      "require mastra-agent.cjs in /app/dist-electron",
    ]);
    expect(loader.loaded).toBe(true);
  });

  it("single-flight: callers that arrive during a load share it; a success is kept for the process", async () => {
    const requireModule = vi.fn(() => RUNTIME);
    const applyEnv = vi.fn();
    const loader = createMastraAgentLoader({
      isOpen: () => true,
      applyEnv,
      requireModule,
    });
    const [a, b, c] = await Promise.all([
      loader.load(),
      loader.load(),
      loader.load(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await loader.load();
    expect(requireModule).toHaveBeenCalledTimes(1);
    expect(applyEnv).toHaveBeenCalledTimes(1);
  });

  it("a failure is not cached and not retried inside the call: the next call is a new load that can succeed", async () => {
    let failures = 1;
    const requireModule = vi.fn(() => {
      if (failures-- > 0) throw new Error("ENOENT: no such file");
      return RUNTIME;
    });
    const loader = createMastraAgentLoader({
      isOpen: () => true,
      applyEnv: () => undefined,
      requireModule,
    });
    const failed = loader.load();
    await expect(failed).rejects.toBeInstanceOf(MastraAgentLoadError);
    await expect(failed).rejects.toMatchObject({ code: "load-failed" });
    expect(requireModule).toHaveBeenCalledTimes(1);
    expect(loader.loaded).toBe(false);
    await expect(loader.load()).resolves.toBe(RUNTIME);
    expect(requireModule).toHaveBeenCalledTimes(2);
  });

  it("a module without the runtime's factory is refused and not kept", async () => {
    const requireModule = vi.fn(() => ({}));
    const loader = createMastraAgentLoader({
      isOpen: () => true,
      applyEnv: () => undefined,
      requireModule,
    });
    await expect(loader.load()).rejects.toMatchObject({
      code: "invalid-module",
    });
    expect(loader.loaded).toBe(false);
  });

  it("the gate is read at every load: a gate that closes later stops a load that has not succeeded", async () => {
    let open = true;
    const requireModule = vi.fn(() => {
      throw new Error("boom");
    });
    const loader = createMastraAgentLoader({
      isOpen: () => open,
      applyEnv: () => undefined,
      requireModule,
    });
    await expect(loader.load()).rejects.toMatchObject({ code: "load-failed" });
    open = false;
    await expect(loader.load()).rejects.toMatchObject({ code: "gate-closed" });
    expect(requireModule).toHaveBeenCalledTimes(1);
  });
});
