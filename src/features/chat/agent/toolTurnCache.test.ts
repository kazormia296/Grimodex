import { describe, it, expect, vi } from "vitest";
import {
  SharedLoader,
  registerToolTurnReset,
  beginAgentToolTurn,
} from "./toolTurnCache";

describe("SharedLoader", () => {
  it("同一 key の連続取得はロード 1 回に畳む", async () => {
    const load = vi.fn(async (key: string) => [key]);
    const loader = new SharedLoader(load);
    expect(await loader.get("p1")).toEqual(["p1"]);
    expect(await loader.get("p1")).toEqual(["p1"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("in-flight 中の並行取得は同一 promise を共有する", async () => {
    let resolve!: (v: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>((res) => (resolve = res)));
    const loader = new SharedLoader<string[]>(load);
    const p1 = loader.get("p1");
    const p2 = loader.get("p1");
    expect(p2).toBe(p1);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(["done"]);
    expect(await p1).toEqual(["done"]);
  });

  it("key が変わると再ロードする", async () => {
    const load = vi.fn(async (key: string) => key);
    const loader = new SharedLoader(load);
    await loader.get("p1");
    await loader.get("p2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clear() 後は再ロードする", async () => {
    const load = vi.fn(async (key: string) => key);
    const loader = new SharedLoader(load);
    await loader.get("p1");
    loader.clear();
    await loader.get("p1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("失敗はキャッシュせず次の取得で再試行する", async () => {
    const load = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");
    const loader = new SharedLoader(load);
    await expect(loader.get("p1")).rejects.toThrow("boom");
    expect(await loader.get("p1")).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("beginAgentToolTurn", () => {
  it("登録済みリセットフックを全て呼ぶ", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerToolTurnReset(a);
    registerToolTurnReset(b);
    beginAgentToolTurn();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
