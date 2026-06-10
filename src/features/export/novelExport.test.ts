import { describe, expect, it } from "vitest";
import { makeNodeData } from "@/test-utils/nodeFixture";
import { NOVEL_SECTION_SEP, parseNovelFile } from "@/lib/novelFormat";
import {
  buildNovelImportPlan,
  codexDraftsToParsedEntries,
} from "@/features/import/novelImporter";
import { fieldValueToProseMirror } from "@/features/import/importApi";
import {
  collectCheckedSceneIdsInOrder,
  generateNovelExport,
  pmDocToNovelLines,
} from "./novelExport";

function doc(...content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

function para(...content: unknown[]): unknown {
  return content.length > 0
    ? { type: "paragraph", content }
    : { type: "paragraph" };
}

function text(t: string): unknown {
  return { type: "text", text: t };
}

describe("pmDocToNovelLines", () => {
  it("1 段落 = 1 行、空段落 = 空行", () => {
    expect(
      pmDocToNovelLines(
        doc(para(text("一行目")), para(), para(text("二行目"))),
      ),
    ).toEqual(["一行目", "", "二行目"]);
  });

  it("テキストノード内の改行（kakuyomu 由来）も行分割する", () => {
    expect(pmDocToNovelLines(doc(para(text("a\nb"))))).toEqual(["a", "b"]);
  });

  it("hardBreak は行分割する", () => {
    expect(
      pmDocToNovelLines(doc(para(text("a"), { type: "hardBreak" }, text("b")))),
    ).toEqual(["a", "b"]);
  });

  it("ルビは parentheses、傍点マークは plain テキスト", () => {
    const lines = pmDocToNovelLines(
      doc(
        para(
          { type: "ruby", attrs: { base: "漢字", annotation: "かんじ" } },
          {
            type: "text",
            text: "強調",
            marks: [{ type: "emphasisDots" }],
          },
        ),
      ),
    );
    expect(lines).toEqual(["漢字(かんじ)強調"]);
  });

  it("mention は resolver で現在名に解決する", () => {
    const lines = pmDocToNovelLines(
      doc(para({ type: "mention", attrs: { id: "e1", label: "旧名" } })),
      {
        resolveMentionName: (id, fallback) => (id === "e1" ? "新名" : fallback),
      },
    );
    expect(lines).toEqual(["新名"]);
  });

  it("sceneBeat は除去、generatedProseBlock は unwrap する", () => {
    const lines = pmDocToNovelLines(
      doc(
        { type: "sceneBeat", attrs: { prompt: "ここで戦闘" } },
        {
          type: "generatedProseBlock",
          content: [para(text("生成された文")) as never],
        },
        para(text("地の文")),
      ),
    );
    expect(lines).toEqual(["生成された文", "地の文"]);
  });

  it("sceneBreak と horizontalRule は区切り行になる", () => {
    expect(
      pmDocToNovelLines(
        doc(para(text("a")), { type: "sceneBreak" }, para(text("b"))),
      ),
    ).toEqual(["a", "* * *", "b"]);
    expect(pmDocToNovelLines(doc({ type: "horizontalRule" }))).toEqual(["---"]);
  });

  it("リストは 1 項目 = 1 行", () => {
    const lines = pmDocToNovelLines(
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [para(text("項目1")) as never] },
          { type: "listItem", content: [para(text("項目2")) as never] },
        ],
      }),
    );
    expect(lines).toEqual(["・項目1", "・項目2"]);
  });

  it("空 doc / 壊れた JSON は空配列", () => {
    expect(pmDocToNovelLines("{}")).toEqual([]);
    expect(pmDocToNovelLines(undefined)).toEqual([]);
    expect(pmDocToNovelLines("not json")).toEqual([]);
  });
});

describe("collectCheckedSceneIdsInOrder", () => {
  it("sortOrder DFS 順でチェック済みシーンのみ返す（note 除外）", () => {
    const nodes = [
      makeNodeData({ id: "f1", nodeType: "folder", sortOrder: "a1" }),
      makeNodeData({ id: "s3", sortOrder: "a2" }),
      makeNodeData({ id: "s1", parentId: "f1", sortOrder: "a0" }),
      makeNodeData({ id: "s2", parentId: "f1", sortOrder: "a1" }),
      makeNodeData({ id: "n1", nodeType: "note", sortOrder: "a0" }),
    ];
    expect(
      collectCheckedSceneIdsInOrder(nodes, new Set(["s1", "s2", "s3", "n1"])),
    ).toEqual(["s1", "s2", "s3"]);
    expect(collectCheckedSceneIdsInOrder(nodes, new Set(["s2"]))).toEqual([
      "s2",
    ]);
  });
});

describe("generateNovelExport", () => {
  const baseInput = {
    title: "作品名",
    outline: "あらすじ",
    aiInstructions: "AI指示",
    sceneDocs: [doc(para(text("一行目")), para(), para(text("三行目")))],
    codexEntries: [
      {
        name: "トリン",
        aliases: ["神様"],
        contentJson: doc(para(text("スフィアの神様。"))),
        summary: "",
      },
    ],
  };

  it("10 セクション構成で正しいインデックスに出力する", () => {
    const out = generateNovelExport(baseInput);
    const sections = out.split(NOVEL_SECTION_SEP);
    expect(sections).toHaveLength(10);
    expect(sections[0]).toBe("一行目<br><br>三行目");
    expect(sections[1]).toBe("あらすじ");
    expect(sections[2]).toBe("AI指示");
    expect(sections[3]).toBe("");
    expect(sections[4]).toBe(
      "トリン, 神様<|entry|>[スフィアの神様。]<|entry|>",
    );
    expect(sections[5]).toBe("");
    expect(sections[6]).toBe("作品名");
    expect(sections[9]).toBe("");
  });

  it("複数シーンは 1 空行（<br><br>）で結合する", () => {
    const out = generateNovelExport({
      ...baseInput,
      sceneDocs: [doc(para(text("シーン1"))), doc(para(text("シーン2")))],
    });
    expect(out.split(NOVEL_SECTION_SEP)[0]).toBe("シーン1<br><br>シーン2");
  });

  it("シーン末尾の空段落は結合前に落とす", () => {
    const out = generateNovelExport({
      ...baseInput,
      sceneDocs: [
        doc(para(text("シーン1")), para()),
        doc(para(text("シーン2"))),
      ],
    });
    expect(out.split(NOVEL_SECTION_SEP)[0]).toBe("シーン1<br><br>シーン2");
  });

  it("本文中の制御トークンとリテラル <br> をサニタイズする", () => {
    const out = generateNovelExport({
      ...baseInput,
      codexEntries: [],
      sceneDocs: [doc(para(text("a<|endofsection|>b<br>c")))],
    });
    expect(out.split(NOVEL_SECTION_SEP)[0]).toBe("ab＜br＞c");
  });

  it("タグ内のカンマ・空白・| は中黒に正規化される（単一トークン保証）", () => {
    const out = generateNovelExport({
      ...baseInput,
      codexEntries: [
        {
          name: "赤井 秀一",
          aliases: ["FBI,狙撃手|凄腕"],
          contentJson: "{}",
          summary: "概要のみ",
        },
      ],
    });
    expect(out.split(NOVEL_SECTION_SEP)[4]).toBe(
      "赤井・秀一, FBI・狙撃手・凄腕<|entry|>[概要のみ]<|entry|>",
    );
  });

  it("説明文（summary 経路）の制御トークンをサニタイズする", () => {
    const out = generateNovelExport({
      ...baseInput,
      codexEntries: [
        {
          name: "x",
          aliases: [],
          contentJson: "{}",
          summary: "前<|entry|>中<|endofsection|>後",
        },
      ],
    });
    expect(out.split(NOVEL_SECTION_SEP)).toHaveLength(10);
    expect(out.split(NOVEL_SECTION_SEP)[4]).toBe("x<|entry|>[前中後]<|entry|>");
  });

  it("説明文（content 経路）の制御トークンをサニタイズする", () => {
    const out = generateNovelExport({
      ...baseInput,
      codexEntries: [
        {
          name: "x",
          aliases: [],
          contentJson: doc(para(text("a<|entry|>b<|endofsection|>c"))),
          summary: "",
        },
      ],
    });
    expect(out.split(NOVEL_SECTION_SEP)).toHaveLength(10);
    expect(out.split(NOVEL_SECTION_SEP)[4]).toBe("x<|entry|>[abc]<|entry|>");
  });

  it("説明文が既にブラケット囲みなら二重 wrap しない", () => {
    const out = generateNovelExport({
      ...baseInput,
      codexEntries: [
        {
          name: "a",
          aliases: [],
          contentJson: doc(para(text("[既に囲み]"))),
          summary: "",
        },
      ],
    });
    expect(out.split(NOVEL_SECTION_SEP)[4]).toBe(
      "a<|entry|>[既に囲み]<|entry|>",
    );
  });

  it("content 空のエントリは summary にフォールバック、説明空は brackets なし", () => {
    const out = generateNovelExport({
      ...baseInput,
      codexEntries: [
        { name: "a", aliases: [], contentJson: "{}", summary: "概要" },
        { name: "b", aliases: [], contentJson: "{}", summary: "" },
      ],
    });
    expect(out.split(NOVEL_SECTION_SEP)[4]).toBe(
      "a<|entry|>[概要]<|entry|>b<|entry|><|entry|>",
    );
  });

  it("codex なし・メタなしでも 10 セクションを保つ", () => {
    const out = generateNovelExport({
      title: "t",
      outline: "",
      aiInstructions: "",
      sceneDocs: [],
      codexEntries: [],
    });
    expect(out.split(NOVEL_SECTION_SEP)).toHaveLength(10);
  });
});

describe("意味的ラウンドトリップ（import → export → re-parse）", () => {
  /**
   * import 側の本番経路を再現して export 入力を作る:
   * importApi.importCodexEntries は ParsedCodexEntry.summary を
   * fieldValueToProseMirror で PM 化して codex の content に書き込む。
   */
  function roundTrip(
    original: string,
  ): ReturnType<typeof parseNovelFile>["novel"] {
    const { novel } = parseNovelFile(original);
    const plan = buildNovelImportPlan(novel, "fallback");
    const parsedEntries = codexDraftsToParsedEntries(
      plan.codexDrafts,
      plan.codexDrafts.map(() => "character"),
    );
    const exported = generateNovelExport({
      title: plan.projectTitle,
      outline: plan.memory,
      aiInstructions: plan.footnote,
      sceneDocs:
        plan.scene.kind === "scene" ? [plan.scene.bodyProseMirror!] : [],
      codexEntries: parsedEntries.map((e) => ({
        name: e.name,
        aliases: e.aliases,
        contentJson: fieldValueToProseMirror(e.summary),
        summary: "",
      })),
    });
    return parseNovelFile(exported).novel;
  }

  it("インポートした本文とキャラクターブックがエクスポートで保たれる", () => {
    const reparsed = roundTrip(
      [
        "本文1<br>本文2<br><br>空行のあと",
        "メモリ",
        "脚注",
        "",
        "tag1<|entry|>[説明1]<|entry|>tag2, test1<|entry|>[説明2\n二行目]<|entry|>",
        "",
        "タイトル",
      ].join(NOVEL_SECTION_SEP),
    );
    expect(reparsed.body).toBe("本文1<br>本文2<br><br>空行のあと");
    expect(reparsed.memory).toBe("メモリ");
    expect(reparsed.footnote).toBe("脚注");
    expect(reparsed.title).toBe("タイトル");
    expect(reparsed.charBook).toEqual([
      { tags: ["tag1"], content: "[説明1]" },
      { tags: ["tag2", "test1"], content: "[説明2\n二行目]" },
    ]);
  });

  it("空白入りタグも往復で単一トークンのまま分裂しない（中黒正規化）", () => {
    const reparsed = roundTrip(
      ["本文", "", "", "", "山田 太郎<|entry|>[説明]<|entry|>", "", "t"].join(
        NOVEL_SECTION_SEP,
      ),
    );
    // import: 仕様どおり空白で 2 タグに分解（name=山田 / aliases=[太郎]）。
    // export: 中黒正規化により「山田, 太郎」の 2 トークンが保たれ、
    // 再 import しても name/aliases の構造が分裂・混線しない。
    expect(reparsed.charBook).toEqual([
      { tags: ["山田", "太郎"], content: "[説明]" },
    ]);
  });

  it("説明文の空行（段落区切り）は落ちる — 既知の lossy をテストで固定", () => {
    const reparsed = roundTrip(
      [
        "本文",
        "",
        "",
        "",
        "tag<|entry|>[段落1\n\n段落2]<|entry|>",
        "",
        "t",
      ].join(NOVEL_SECTION_SEP),
    );
    // fieldValueToProseMirror が空行を段落区切りとして消費するため、
    // 説明文内の空行は往復で 1 改行に縮む（本文側とは別規約）。
    expect(reparsed.charBook).toEqual([
      { tags: ["tag"], content: "[段落1\n段落2]" },
    ]);
  });
});

describe("巨大入力の回帰", () => {
  it("12.5 万行超の本文でも RangeError にならない（push spread 上限）", () => {
    const lineCount = 150_000;
    const paragraphs = Array.from({ length: lineCount }, (_, i) =>
      para(text(`行${i}`)),
    );
    // doc(...paragraphs) は spread 引数上限を踏むため直接組み立てる
    const hugeDoc = JSON.stringify({ type: "doc", content: paragraphs });
    const out = generateNovelExport({
      title: "長編",
      outline: "",
      aiInstructions: "",
      sceneDocs: [hugeDoc],
      codexEntries: [],
    });
    const body = out.split(NOVEL_SECTION_SEP)[0]!;
    expect(body.split("<br>")).toHaveLength(lineCount);
  });
});
