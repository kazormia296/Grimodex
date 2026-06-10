import { describe, expect, it } from "vitest";
import { parseNovelFile } from "@/lib/novelFormat";
import {
  buildNovelImportPlan,
  codexDraftsToParsedEntries,
  novelBodyToProseMirror,
  splitNovelBodyLines,
} from "./novelImporter";

function pmParas(json: string): unknown[] {
  return (JSON.parse(json) as { content: unknown[] }).content;
}

describe("novelBodyToProseMirror", () => {
  it("1 行 = 1 段落に変換する", () => {
    const doc = JSON.parse(novelBodyToProseMirror("一行目<br>二行目"));
    expect(doc).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "一行目" }] },
        { type: "paragraph", content: [{ type: "text", text: "二行目" }] },
      ],
    });
  });

  it("連続 <br> は空段落になる（サンプル本文: 4 連続 <br> → 空段落 3 つ）", () => {
    const paras = pmParas(
      novelBodyToProseMirror("↑改行のみの行<br><br><br><br>↑改行のみの3行"),
    );
    expect(paras).toHaveLength(5);
    expect(paras[1]).toEqual({ type: "paragraph" });
    expect(paras[2]).toEqual({ type: "paragraph" });
    expect(paras[3]).toEqual({ type: "paragraph" });
  });

  it("<br/> や <BR> 表記も行区切りとして扱う", () => {
    expect(splitNovelBodyLines("a<br/>b<BR>c<br />d")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("防御的に生改行も行区切りとして扱う", () => {
    expect(splitNovelBodyLines("a\nb")).toEqual(["a", "b"]);
  });

  it("空文字は空 doc", () => {
    expect(novelBodyToProseMirror("")).toBe(
      JSON.stringify({ type: "doc", content: [] }),
    );
  });
});

describe("buildNovelImportPlan", () => {
  const sample = [
    "本文1<br>本文2",
    "メモリ内容",
    "脚注内容",
    "",
    "tag1<|entry|>[説明1]<|entry|>tag2, test1<|entry|>説明2<|entry|>",
    "",
    "作品タイトル",
  ].join("<|endofsection|>");

  it("タイトル・本文・メモリ・脚注・キャラクターブックを割り付ける", () => {
    const plan = buildNovelImportPlan(parseNovelFile(sample).novel, "fallback");
    expect(plan.projectTitle).toBe("作品タイトル");
    expect(plan.scene.kind).toBe("scene");
    expect(plan.scene.title).toBe("作品タイトル");
    expect(plan.memory).toBe("メモリ内容");
    expect(plan.footnote).toBe("脚注内容");
    expect(plan.bodyLineCount).toBe(2);
    expect(plan.bodyCharCount).toBe(6);
    expect(plan.warnings).toEqual([]);
    if (plan.scene.kind === "scene") {
      expect(pmParas(plan.scene.bodyProseMirror!)).toHaveLength(2);
    }
  });

  it("codexDrafts は先頭タグ=name・残り=aliases・ブラケット除去済み説明文", () => {
    const plan = buildNovelImportPlan(parseNovelFile(sample).novel, "fallback");
    expect(plan.codexDrafts).toEqual([
      { name: "tag1", aliases: [], description: "説明1" },
      { name: "tag2", aliases: ["test1"], description: "説明2" },
    ]);
  });

  it("タイトルが空ならファイル名にフォールバックする", () => {
    const plan = buildNovelImportPlan(
      parseNovelFile("本文だけ").novel,
      "ファイル名",
    );
    expect(plan.projectTitle).toBe("ファイル名");
    expect(plan.scene.title).toBe("ファイル名");
  });

  it("本文が空なら警告を出しつつ続行する", () => {
    const plan = buildNovelImportPlan(
      parseNovelFile("<|endofsection|><|endofsection|>").novel,
      "t",
    );
    expect(plan.bodyLineCount).toBe(0);
    expect(plan.warnings).toHaveLength(1);
  });
});

describe("codexDraftsToParsedEntries", () => {
  it("ParsedCodexEntry の形状に変換する（summary 経由で content 化される前提）", () => {
    const entries = codexDraftsToParsedEntries(
      [
        { name: "トリン", aliases: ["神様"], description: "スフィアの神様。" },
        { name: "ワーズ", aliases: [], description: "" },
      ],
      ["character", "lore"],
    );
    expect(entries[0]).toMatchObject({
      ncId: "",
      type: "character",
      name: "トリン",
      aliases: ["神様"],
      summary: "スフィアの神様。",
      content: "{}",
      contextMode: "mentioned",
      tagsCache: "[]",
    });
    expect(entries[1]!.type).toBe("lore");
    expect(entries[0]!.id).not.toBe(entries[1]!.id);
  });

  it("タイプ未指定は character にフォールバックする", () => {
    const entries = codexDraftsToParsedEntries(
      [{ name: "a", aliases: [], description: "" }],
      [],
    );
    expect(entries[0]!.type).toBe("character");
  });
});
