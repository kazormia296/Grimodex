import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseKakuyomuZip } from "./kakuyomuParser";
import { countFoldersInTree, countScenesInTree } from "./markdownParser";

function makeKakuyomuZip(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    input[path] = strToU8(content);
  }
  return zipSync(input);
}

const FLAT_ABOUT = `【タイトル】
小説タイトル

【作者名】
@grimodex

【ジャンル】
現代ファンタジー

【紹介文（1行）】
紹介文

【タグ】
- タグ1
- タグ2

【目次】
  1. 話数入力欄
`;

const FLAT_EPISODE = `【タイトル】
話数入力欄

【公開状態】
下書き

【本文（4行）】
\u3000本文
\u3000ルビ記法《きほう》
\u3000《《傍点》》
\u3000段落一字下げはただの全角スペース---------
`;

const NESTED_ABOUT = `【タイトル】
小説タイトル

【ジャンル】
現代ファンタジー

【紹介文（1行）】
紹介文

【公開日時】
2026-05-24 13:09:50（+09:00）

【目次】
§ 大見出し章追加
  1. 話数入力欄
  § 小見出し章追加
    2. 二話目
`;

const EPISODE_1 = `【タイトル】
話数入力欄

【本文（2行）】
第一話本文
`;

const EPISODE_2 = `【タイトル】
二話目

【本文（2行）】
第二話本文
`;

describe("parseKakuyomuZip", () => {
  it("parses flat structure (no chapter headers)", () => {
    const zip = makeKakuyomuZip({
      "about.txt": FLAT_ABOUT,
      "episode_0001.txt": FLAT_EPISODE,
    });
    const result = parseKakuyomuZip(zip);

    expect(result.flatStructure).toBe(true);
    expect(result.projectTitle).toBe("小説タイトル");
    expect(result.metadata.genre).toBe("現代ファンタジー");
    expect(result.metadata.outline).toBe("紹介文");
    expect(result.metadata.tags).toEqual(["タグ1", "タグ2"]);
    expect(countFoldersInTree(result.tree)).toBe(1);
    expect(countScenesInTree(result.tree)).toBe(1);
    expect(result.tree[0]?.kind).toBe("folder");
    if (result.tree[0]?.kind === "folder") {
      expect(result.tree[0].title).toBe("小説タイトル");
      expect(result.tree[0].children[0]?.kind).toBe("scene");
      if (result.tree[0].children[0]?.kind === "scene") {
        expect(result.tree[0].children[0].title).toBe("話数入力欄");
        expect(result.tree[0].children[0].bodyProseMirror).toContain("ruby");
      }
    }
  });

  it("parses nested chapter structure from toc", () => {
    const zip = makeKakuyomuZip({
      "about.txt": NESTED_ABOUT,
      "episode_0001.txt": EPISODE_1,
      "episode_0002.txt": EPISODE_2,
    });
    const result = parseKakuyomuZip(zip);

    expect(result.flatStructure).toBe(false);
    expect(countFoldersInTree(result.tree)).toBe(2);
    expect(countScenesInTree(result.tree)).toBe(2);

    const root = result.tree[0];
    expect(root?.kind).toBe("folder");
    if (root?.kind === "folder") {
      expect(root.title).toBe("大見出し章追加");
      expect(
        root.children.some(
          (c) => c.kind === "scene" && c.title === "話数入力欄",
        ),
      ).toBe(true);
      const sub = root.children.find((c) => c.kind === "folder");
      expect(sub?.kind).toBe("folder");
      if (sub?.kind === "folder") {
        expect(sub.title).toBe("小見出し章追加");
        expect(sub.children[0]?.kind).toBe("scene");
        if (sub.children[0]?.kind === "scene") {
          expect(sub.children[0].title).toBe("二話目");
        }
      }
    }
  });

  it("throws when about.txt is missing", () => {
    const zip = makeKakuyomuZip({ "episode_0001.txt": EPISODE_1 });
    expect(() => parseKakuyomuZip(zip)).toThrow(/about\.txt/);
  });
});
