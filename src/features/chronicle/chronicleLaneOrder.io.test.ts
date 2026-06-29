import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/settings/api", () => ({
  getProjectSetting: vi.fn(),
  setProjectSetting: vi.fn(),
}));

import { getProjectSetting, setProjectSetting } from "@/features/settings/api";
import { loadLaneOrder, saveLaneOrder } from "./chronicleLaneOrder";

const mockGet = vi.mocked(getProjectSetting);
const mockSet = vi.mocked(setProjectSetting);

describe("chronicleLaneOrder IO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saveLaneOrder は projectSettings へ key/JSON で書く", async () => {
    mockSet.mockResolvedValue(undefined);
    await saveLaneOrder("p1", ["c2", "c1"]);
    expect(mockSet).toHaveBeenCalledWith(
      "p1",
      "chronicle.laneOrder",
      JSON.stringify(["c2", "c1"]),
    );
  });

  it("loadLaneOrder は JSON 配列を復元", async () => {
    mockGet.mockResolvedValue(JSON.stringify(["a", "b"]));
    expect(await loadLaneOrder("p1")).toEqual(["a", "b"]);
  });

  it("未保存(null)は []", async () => {
    mockGet.mockResolvedValue(null);
    expect(await loadLaneOrder("p1")).toEqual([]);
  });

  it("壊れた JSON は []", async () => {
    mockGet.mockResolvedValue("{not json");
    expect(await loadLaneOrder("p1")).toEqual([]);
  });

  it("非配列 JSON は []", async () => {
    mockGet.mockResolvedValue(JSON.stringify({ a: 1 }));
    expect(await loadLaneOrder("p1")).toEqual([]);
  });

  it("文字列以外の要素を含む配列は []", async () => {
    mockGet.mockResolvedValue(JSON.stringify(["a", 3, "b"]));
    expect(await loadLaneOrder("p1")).toEqual([]);
  });

  it("getProjectSetting が throw しても [] にフォールバック", async () => {
    mockGet.mockRejectedValue(new Error("db down"));
    expect(await loadLaneOrder("p1")).toEqual([]);
  });
});
