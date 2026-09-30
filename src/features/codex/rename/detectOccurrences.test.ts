import { describe, it, expect } from "vitest";
import {
  detectRenameOccurrences,
  type RenameSourceText,
} from "./detectOccurrences";
import type { CodexMatchTarget } from "../codexMatcher";

function target(
  id: string,
  name: string,
  extra: Partial<CodexMatchTarget> = {},
): CodexMatchTarget {
  return { id, name, type: "character", ...extra };
}

function sceneSource(
  text: string,
  isRubyByOffset?: boolean[],
): RenameSourceText {
  return {
    kind: "scene-body",
    refId: "s1",
    baseVersion: 0,
    refLabel: "シーン1",
    text,
    isRubyByOffset,
  };
}

describe("detectRenameOccurrences", () => {
  it("地の文の旧名出現を検出する", () => {
    const targets = [target("e1", "アキラ")];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "アキラ",
      newName: "アキト",
      allTargets: targets,
      sources: [sceneSource("アキラは走った。アキラの声。")],
    });
    expect(res.occurrences).toHaveLength(2);
    expect(res.occurrences.map((o) => [o.from, o.to])).toEqual([
      [0, 3],
      [8, 11],
    ]);
    expect(res.ambiguous).toBe(false);
  });

  it("より長い別エントリ名に含まれる部分文字列は除外 (longest-match)", () => {
    const targets = [target("e1", "太郎"), target("e2", "山田太郎")];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "太郎",
      newName: "次郎",
      allTargets: targets,
      // 「山田太郎」内の「太郎」は e2 に帰属するので拾わない。単独の「太郎」のみ。
      sources: [sceneSource("山田太郎と太郎は別人だ。")],
    });
    expect(res.occurrences).toHaveLength(1);
    const o = res.occurrences[0]!;
    expect(o.hit).toBe("太郎");
    // 「山田太郎」(0-4) ではなく単独の「太郎」(5-7)
    expect([o.from, o.to]).toEqual([5, 7]);
  });

  it("同名の別エントリがあると ambiguous=true だが出現は拾う (silent miss 防止)", () => {
    const targets = [target("e1", "ハル"), target("e2", "ハル")];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "ハル",
      newName: "ナツ",
      allTargets: targets,
      sources: [sceneSource("ハルが来た。")],
    });
    expect(res.ambiguous).toBe(true);
    expect(res.occurrences).toHaveLength(1);
  });

  it("旧名が別エントリの alias と一致すると ambiguous=true", () => {
    const targets = [
      target("e1", "ハル"),
      target("e2", "春", { aliases: ["ハル"] }),
    ];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "ハル",
      newName: "ナツ",
      allTargets: targets,
      sources: [sceneSource("ハル。")],
    });
    expect(res.ambiguous).toBe(true);
  });

  it("ruby atom に重なる一致は ruby=true でフラグ", () => {
    const text = "太郎は";
    // 「太郎」(offset 0,1) が ruby base、" は" は通常テキスト
    const isRuby = [true, true, false];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "太郎",
      newName: "次郎",
      allTargets: [target("e1", "太郎")],
      sources: [sceneSource(text, isRuby)],
    });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0]!.ruby).toBe(true);
  });

  it("旧名==新名 や 空名 は no-op", () => {
    const targets = [target("e1", "アキラ")];
    expect(
      detectRenameOccurrences({
        entryId: "e1",
        oldName: "アキラ",
        newName: "アキラ",
        allTargets: targets,
        sources: [sceneSource("アキラ")],
      }).occurrences,
    ).toHaveLength(0);
    expect(
      detectRenameOccurrences({
        entryId: "e1",
        oldName: "",
        newName: "アキラ",
        allTargets: targets,
        sources: [sceneSource("アキラ")],
      }).occurrences,
    ).toHaveLength(0);
  });

  it("複数 source を横断し snippet を付ける", () => {
    const sources: RenameSourceText[] = [
      sceneSource("むかしアキラがいた。"),
      {
        kind: "codex-summary",
        refId: "e2",
        baseVersion: 0,
        refLabel: "別キャラ",
        text: "アキラの弟。",
      },
    ];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "アキラ",
      newName: "アキト",
      allTargets: [target("e1", "アキラ"), target("e2", "別キャラ")],
      sources,
    });
    expect(res.occurrences).toHaveLength(2);
    const summaryOcc = res.occurrences.find(
      (o) => o.source.kind === "codex-summary",
    )!;
    expect(summaryOcc.hit).toBe("アキラ");
    expect(summaryOcc.after).toContain("の弟");
  });

  it("excludedAliases に覆われる位置は除外 (matcher 由来)", () => {
    const targets = [target("e1", "金", { excludedAliases: ["お金"] })];
    const res = detectRenameOccurrences({
      entryId: "e1",
      oldName: "金",
      newName: "ゴールド",
      allTargets: targets,
      sources: [sceneSource("お金が要る。金もある。")],
    });
    // 「お金」内の「金」は除外、単独の「金」のみ
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0]!.from).toBe(6);
  });
});
