// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  clearBunsetsuCache,
  fetchBunsetsuUnits,
  getCachedBunsetsuUnits,
} from "./bunsetsuSegmenter";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("bunsetsuSegmenter", () => {
  beforeEach(() => {
    clearBunsetsuCache();
    vi.mocked(invoke).mockReset();
  });

  it("invoke 成功で units を返し cache する", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { start: 0, end: 2, surface: "彼女" },
      { start: 2, end: 3, surface: "は" },
    ]);
    const units = await fetchBunsetsuUnits("彼女は");
    expect(units).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    const again = await fetchBunsetsuUnits("彼女は");
    expect(again).toEqual(units);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("in-flight promise を reuse する", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p1 = fetchBunsetsuUnits("テスト");
    const p2 = fetchBunsetsuUnits("テスト");
    resolve([{ start: 0, end: 3, surface: "テスト" }]);
    const [u1, u2] = await Promise.all([p1, p2]);
    expect(u1).toEqual(u2);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("getCachedBunsetsuUnits は state なしで null", () => {
    expect(getCachedBunsetsuUnits(null, "ja")).toBeNull();
  });
});
