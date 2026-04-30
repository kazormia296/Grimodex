import { describe, it, expect } from "vitest";
import { buildPendingBeatsSection } from "./pendingBeatsContext";
import type { BuildPendingBeatsInput } from "./pendingBeatsContext";
import type { UnplacedBeat } from "./unplacedBeatsStore";

const noResolver = (_id: string) => null;
const resolver = (map: Record<string, string>) => (id: string) =>
  map[id] ?? null;

function makeSceneBeatJson(
  id: string,
  text: string,
  beatType = "free",
  pov: string | null = null,
) {
  return {
    type: "sceneBeat",
    attrs: { id, beatType, pov, collapsed: false },
    content: [{ type: "text", text }],
  };
}

function makeDocJson(...beats: ReturnType<typeof makeSceneBeatJson>[]) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "intro" }] },
      ...beats,
      { type: "paragraph", content: [{ type: "text", text: "outro" }] },
    ],
  };
}

function makeUnplaced(
  id: string,
  text: string,
  beatType: UnplacedBeat["beatType"] = "free",
  pov: string | null = null,
): UnplacedBeat {
  return {
    id,
    beatType,
    pov,
    collapsed: false,
    content: [{ type: "text", text }],
  };
}

const base: Omit<BuildPendingBeatsInput, "currentBeatId"> = {
  sceneDocJson: null,
  unplacedBeats: [],
  resolveCharacterName: noResolver,
};

describe("buildPendingBeatsSection", () => {
  it("空入力 → 空文字を返す", () => {
    expect(buildPendingBeatsSection({ ...base, currentBeatId: null })).toBe("");
  });

  it("sceneDocJson が null でも Unplaced があれば出力する", () => {
    const result = buildPendingBeatsSection({
      ...base,
      unplacedBeats: [makeUnplaced("u1", "ここで何かが起きる")],
      currentBeatId: null,
    });
    expect(result).toContain("Unplaced");
    expect(result).toContain("ここで何かが起きる");
  });

  it("currentBeatId === null → 全 Placed + 全 Unplaced を含む", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "最初のビート"),
      makeSceneBeatJson("b2", "次のビート"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [makeUnplaced("u1", "未配置ビート")],
      resolveCharacterName: noResolver,
      currentBeatId: null,
    });
    expect(result).toContain("Placed #1");
    expect(result).toContain("最初のビート");
    expect(result).toContain("Placed #2");
    expect(result).toContain("次のビート");
    expect(result).toContain("Unplaced");
    expect(result).toContain("未配置ビート");
  });

  it("currentBeatId が b2 → b3 以降 + Unplaced のみ含む（b1・b2 は除外）", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "ビート1"),
      makeSceneBeatJson("b2", "ビート2"),
      makeSceneBeatJson("b3", "ビート3"),
      makeSceneBeatJson("b4", "ビート4"),
      makeSceneBeatJson("b5", "ビート5"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [makeUnplaced("u1", "未配置")],
      resolveCharacterName: noResolver,
      currentBeatId: "b2",
    });
    expect(result).not.toContain("ビート1");
    expect(result).not.toContain("ビート2");
    expect(result).toContain("Placed #3");
    expect(result).toContain("ビート3");
    expect(result).toContain("Placed #4");
    expect(result).toContain("ビート4");
    expect(result).toContain("Placed #5");
    expect(result).toContain("ビート5");
    expect(result).toContain("未配置");
  });

  it("Placed のみ、Unplaced なし → Placed だけ出力", () => {
    const doc = makeDocJson(makeSceneBeatJson("b1", "唯一のビート"));
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: null,
    });
    expect(result).toContain("Placed #1");
    expect(result).not.toContain("Unplaced");
  });

  it("POV がシーン POV と異なるとき POV ラベルを付与する", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "花子視点のビート", "free", "char-hanako"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: resolver({ "char-hanako": "花子" }),
      currentBeatId: null,
      scenePovCharacterId: "char-taro",
    });
    expect(result).toContain("POV: 花子");
  });

  it("POV がシーン POV と一致するとき POV ラベルを付与しない", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "太郎視点のビート", "free", "char-taro"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: resolver({ "char-taro": "太郎" }),
      currentBeatId: null,
      scenePovCharacterId: "char-taro",
    });
    expect(result).not.toContain("POV:");
  });

  it("resolver が null を返すキャラは POV ラベルを省略する", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "謎の視点", "free", "char-unknown"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: null,
      scenePovCharacterId: "char-taro",
    });
    expect(result).not.toContain("POV:");
  });

  it("instructions が 200 文字を超えると truncate する", () => {
    const longText = "あ".repeat(201);
    const doc = makeDocJson(makeSceneBeatJson("b1", longText));
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: null,
    });
    // 200 文字 + 省略記号
    expect(result).toContain("あ".repeat(200) + "…");
    // 201 文字目は含まれない
    expect(result).not.toContain("あ".repeat(201));
  });

  it("Unplaced の instructions が 200 文字を超えると truncate する", () => {
    const longText = "い".repeat(201);
    const result = buildPendingBeatsSection({
      sceneDocJson: null,
      unplacedBeats: [makeUnplaced("u1", longText)],
      resolveCharacterName: noResolver,
      currentBeatId: null,
    });
    expect(result).toContain("い".repeat(200) + "…");
  });

  it("beatType が section ラベルに含まれる", () => {
    const doc = makeDocJson(makeSceneBeatJson("b1", "風景描写", "setting"));
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: null,
    });
    expect(result).toContain("setting");
  });

  it("currentBeatId が最後の Placed (b5) のとき後続 Placed は空 + Unplaced のみ", () => {
    // 境界: slice(N+1) が空配列を返すケース
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "ビート1"),
      makeSceneBeatJson("b2", "ビート2"),
      makeSceneBeatJson("b3", "ビート3"),
      makeSceneBeatJson("b4", "ビート4"),
      makeSceneBeatJson("b5", "ビート5"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [makeUnplaced("u1", "未配置だけ残る")],
      resolveCharacterName: noResolver,
      currentBeatId: "b5",
    });
    expect(result).not.toContain("Placed");
    expect(result).not.toContain("ビート1");
    expect(result).not.toContain("ビート5");
    expect(result).toContain("Unplaced");
    expect(result).toContain("未配置だけ残る");
  });

  it("currentBeatId が最後の Placed (b5) で Unplaced もないとき空文字を返す", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "ビート1"),
      makeSceneBeatJson("b5", "ビート5"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: "b5",
    });
    expect(result).toBe("");
  });

  it("currentBeatId が存在しない beat id のとき全 Placed を含む", () => {
    const doc = makeDocJson(
      makeSceneBeatJson("b1", "ビート1"),
      makeSceneBeatJson("b2", "ビート2"),
    );
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: "nonexistent",
    });
    expect(result).toContain("ビート1");
    expect(result).toContain("ビート2");
  });

  it("セクションヘッダは ## このシーンの予定ビート で始まる", () => {
    const doc = makeDocJson(makeSceneBeatJson("b1", "ビート1"));
    const result = buildPendingBeatsSection({
      sceneDocJson: doc,
      unplacedBeats: [],
      resolveCharacterName: noResolver,
      currentBeatId: null,
    });
    expect(result).toContain("## このシーンの予定ビート");
  });
});
