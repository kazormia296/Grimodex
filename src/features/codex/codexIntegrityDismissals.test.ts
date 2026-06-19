import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/settings/api", () => ({
  getProjectSetting: vi.fn(),
  setProjectSetting: vi.fn(),
  deleteProjectSetting: vi.fn(),
}));

import {
  getProjectSetting,
  setProjectSetting,
  deleteProjectSetting,
} from "@/features/settings/api";
import {
  DISMISSED_INTEGRITY_KEY,
  loadDismissedIntegrityKeys,
  saveDismissedIntegrityKeys,
} from "./codexIntegrityDismissals";
import { integrityIssueKey } from "./codexIntegrity";

const mockGet = vi.mocked(getProjectSetting);
const mockSet = vi.mocked(setProjectSetting);
const mockDelete = vi.mocked(deleteProjectSetting);

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
});

describe("loadDismissedIntegrityKeys", () => {
  it("行が無ければ空集合", async () => {
    mockGet.mockResolvedValue(null);
    expect(await loadDismissedIntegrityKeys("p1")).toEqual(new Set());
    expect(mockGet).toHaveBeenCalledWith("p1", DISMISSED_INTEGRITY_KEY);
  });

  it("JSON 配列をパースして集合化する", async () => {
    mockGet.mockResolvedValue(JSON.stringify(["alias:a", "self:x:custom"]));
    expect(await loadDismissedIntegrityKeys("p1")).toEqual(
      new Set(["alias:a", "self:x:custom"]),
    );
  });

  it("壊れた JSON は空集合 (fail-safe で警告は出す側)", async () => {
    mockGet.mockResolvedValue("{not json");
    expect(await loadDismissedIntegrityKeys("p1")).toEqual(new Set());
  });

  it("配列でない / 文字列でない要素は弾く", async () => {
    mockGet.mockResolvedValue(JSON.stringify({ a: 1 }));
    expect(await loadDismissedIntegrityKeys("p1")).toEqual(new Set());
    mockGet.mockResolvedValue(JSON.stringify(["ok", 3, null, "ok2"]));
    expect(await loadDismissedIntegrityKeys("p1")).toEqual(
      new Set(["ok", "ok2"]),
    );
  });
});

describe("saveDismissedIntegrityKeys", () => {
  it("非空ならソート済み JSON 配列で保存する", async () => {
    await saveDismissedIntegrityKeys("p1", new Set(["b", "a", "c"]));
    expect(mockSet).toHaveBeenCalledWith(
      "p1",
      DISMISSED_INTEGRITY_KEY,
      JSON.stringify(["a", "b", "c"]),
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("空集合なら行を削除して掃除する", async () => {
    await saveDismissedIntegrityKeys("p1", new Set());
    expect(mockDelete).toHaveBeenCalledWith("p1", DISMISSED_INTEGRITY_KEY);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("integrityIssueKey", () => {
  it("3 種の issue で安定なキーを返す (alias は参加 id 昇順を畳み込む)", () => {
    expect(
      integrityIssueKey({
        kind: "alias-collision",
        normalized: "シオン",
        // surfaces の並びに依らず id は昇順に正規化される。
        surfaces: [
          { entryId: "b", surface: "シオン" },
          { entryId: "a", surface: "シオン" },
        ],
      }),
    ).toBe("alias:シオン:a|b");
    expect(
      integrityIssueKey({
        kind: "duplicate-relation",
        relationType: "ally",
        entryIds: ["a", "b"],
        count: 2,
      }),
    ).toBe("dup:a|b:ally");
    expect(
      integrityIssueKey({
        kind: "self-relation",
        relationType: "custom",
        entryId: "x",
      }),
    ).toBe("self:x:custom");
  });

  it("relationType の大文字小文字違いは同一キー (再計算でキーが揺れない)", () => {
    const upper = integrityIssueKey({
      kind: "duplicate-relation",
      relationType: "Friend",
      entryIds: ["a", "b"],
      count: 2,
    });
    const lower = integrityIssueKey({
      kind: "duplicate-relation",
      relationType: "friend",
      entryIds: ["a", "b"],
      count: 2,
    });
    expect(upper).toBe(lower);
    expect(upper).toBe("dup:a|b:friend");

    expect(
      integrityIssueKey({
        kind: "self-relation",
        relationType: "Custom",
        entryId: "x",
      }),
    ).toBe("self:x:custom");
  });
});
