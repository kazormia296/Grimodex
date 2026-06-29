import { describe, expect, it } from "vitest";
import {
  GROUP_PREFIX,
  groupLaneKey,
  laneTargetKey,
  decodeLaneTarget,
} from "./chronicleLayout";

// 未割当の複数レーン（laneGroup）を 1 本の codexId 文字列チャンネルで運ぶ
// エンコード/デコードの不変条件。viewport(encode)↔panel(decode) の往復を gate。
describe("laneTargetKey / decodeLaneTarget", () => {
  it("実 codex レーンは codexId をそのまま運び primaryCodexId へ解く", () => {
    const key = laneTargetKey({
      unassigned: false,
      codexId: "c1",
    });
    expect(key).toBe("c1");
    expect(decodeLaneTarget(key)).toEqual({
      primaryCodexId: "c1",
      laneGroup: "",
    });
  });

  it("基底未割当レーン（groupId 無し）は null→両フィールド空（NULL クリア）", () => {
    const key = laneTargetKey({ unassigned: true, codexId: null });
    expect(key).toBeNull();
    expect(decodeLaneTarget(key)).toEqual({
      primaryCodexId: "",
      laneGroup: "",
    });
  });

  it("未割当の追加群は __group_<id> を運び laneGroup へ解く", () => {
    const key = laneTargetKey({
      unassigned: true,
      codexId: null,
      groupId: "g3",
    });
    expect(key).toBe(`${GROUP_PREFIX}g3`);
    expect(key).toBe(groupLaneKey("g3"));
    expect(decodeLaneTarget(key)).toEqual({
      primaryCodexId: "",
      laneGroup: "g3",
    });
  });

  it("空グループ id（接頭辞のみ）でも laneGroup は空文字に解ける", () => {
    expect(decodeLaneTarget(GROUP_PREFIX)).toEqual({
      primaryCodexId: "",
      laneGroup: "",
    });
  });
});
