import { describe, it, expect } from "vitest";
import {
  parseEventProposals,
  buildExtractEventsPrompt,
} from "./extractEventsApi";

const allowed = new Set(["s1", "s2"]);

describe("parseEventProposals", () => {
  it("JSON(コードフェンス可)から title＋許可 scene 参照のみ抽出", () => {
    const text =
      '```json\n{"events":[{"title":"王の崩御","evidenceSceneIds":["s1","ghost"],"note":"重要"}]}\n```';
    const out = parseEventProposals(text, allowed);
    expect(out).toEqual([
      { title: "王の崩御", evidenceSceneIds: ["s1"], note: "重要" },
    ]);
  });

  it("title 空 / events 非配列 は除外", () => {
    expect(
      parseEventProposals(
        '{"events":[{"title":"  ","evidenceSceneIds":["s1"]}]}',
        allowed,
      ),
    ).toEqual([]);
    expect(parseEventProposals('{"events":"x"}', allowed)).toEqual([]);
  });

  it("evidenceSceneIds は重複排除・全て不正なら空配列で残す", () => {
    const out = parseEventProposals(
      '{"events":[{"title":"会議","evidenceSceneIds":["s2","s2","bad"]}]}',
      allowed,
    );
    expect(out).toEqual([{ title: "会議", evidenceSceneIds: ["s2"] }]);
  });

  it("壊れた JSON は空", () => {
    expect(parseEventProposals("not json", allowed)).toEqual([]);
  });
});

describe("buildExtractEventsPrompt", () => {
  it("scene 本文と id・カスタム指示をプロンプトに含む", () => {
    const p = buildExtractEventsPrompt({
      scenes: [
        { sceneId: "s1", title: "場面1", bodyText: "本文A", orderIndex: 0 },
      ],
      existingTitles: ["既存出来事"],
      customInstruction: "簡潔に",
    });
    expect(p).toContain("s1");
    expect(p).toContain("本文A");
    expect(p).toContain("既存出来事");
    expect(p).toContain("簡潔に");
    // 期待する JSON 形を明示している
    expect(p).toContain("evidenceSceneIds");
  });
});
