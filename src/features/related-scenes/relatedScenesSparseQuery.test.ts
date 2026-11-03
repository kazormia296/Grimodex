import { describe, it, expect } from "vitest";
import { prosemirrorToText } from "@/lib/prosemirror";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import { buildSparseQuery } from "./seedTerms";
import { buildRelatedScenesSparseQuery } from "./relatedScenesSparseQuery";

const TAIL = "末尾の文。これは tail の文である。";

function entry(
  id: string,
  name: string,
  options: { type?: string; aliases?: string[]; excluded?: string[] } = {},
): CodexMatchTarget {
  // DB の行（CodexMatchRow）と同じく、別名は JSON 文字列で渡す。
  return {
    id,
    name,
    type: options.type ?? "character",
    aliases: JSON.stringify(options.aliases ?? []),
    excludedAliases: JSON.stringify(options.excluded ?? []),
  };
}

const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const docOf = (...paragraphs: unknown[]) =>
  JSON.stringify({ type: "doc", content: paragraphs });
const docText = (...lines: string[]) =>
  docOf(...lines.map((line) => paragraph(text(line))));

function build(
  docJson: string,
  codexTargets: CodexMatchTarget[] = [],
  language = "ja",
) {
  const body = prosemirrorToText(docJson);
  return {
    body,
    query: buildRelatedScenesSparseQuery({
      tailQuery: TAIL,
      body,
      docJson,
      language,
      codexTargets,
    }),
  };
}

describe("buildRelatedScenesSparseQuery：英語の分岐", () => {
  it.each(["en", "en-US"])(
    "%s は Codex・ルビがあっても buildSparseQuery と同じ文字列",
    (language) => {
      const docJson = docOf(
        paragraph(
          { type: "ruby", attrs: { base: "長谷部", annotation: "はせべ" } },
          text("Aria met Valdor near the Iron Crown."),
        ),
      );
      const targets = [entry("e1", "長谷部"), entry("e2", "Aria")];
      const { body, query } = build(docJson, targets, language);
      expect(query).toBe(buildSparseQuery(TAIL, body));
    },
  );

  it("英語で seed が無いときも buildSparseQuery と同じ（tail だけ）", () => {
    const { body, query } = build(docText("he walked home."), [], "en");
    expect(query).toBe(buildSparseQuery(TAIL, body));
    expect(query).toBe(TAIL);
  });
});

describe("buildRelatedScenesSparseQuery：言語の述語", () => {
  it.each(["ja", "zh", "", "EN-US"])(
    "%j は日本語の分岐（startsWith は大小を区別する。recallParamsForLang と同じ）",
    (language) => {
      const { query } = build(
        docText("長谷部は笑った。"),
        [entry("e1", "長谷部")],
        language,
      );
      expect(query).toBe("長谷部");
    },
  );
});

describe("buildRelatedScenesSparseQuery：日本語の分岐", () => {
  it("語があるときは tail を入れない", () => {
    const { query } = build(docText("長谷部は笑った。"), [
      entry("e1", "長谷部"),
    ]);
    expect(query).not.toContain("tail");
    expect(query).not.toContain("末尾の文");
  });

  it("3 字以上の Codex 名（漢字・カタカナ）が本文にあれば入る", () => {
    const { query } = build(docText("長谷部とアリアは塔へ向かった。"), [
      entry("e1", "長谷部"),
      entry("e2", "アリア"),
    ]);
    expect(query.split(" ")).toEqual(["長谷部", "アリア"]);
  });

  it("ルビの base で言及を拾う（prosemirrorToText では消える名前）", () => {
    const docJson = docOf(
      paragraph(
        { type: "ruby", attrs: { base: "長谷部", annotation: "はせべ" } },
        text("は振り返った。"),
      ),
    );
    const { body, query } = build(docJson, [entry("e1", "長谷部")]);
    expect(body).toBe("は振り返った。\n");
    expect(query).toBe("長谷部");
  });

  it("mention の atom の label は照合に入れない", () => {
    const docJson = docOf(
      paragraph(
        { type: "mention", attrs: { id: "e1", label: "長谷部" } },
        text("が来た。"),
      ),
    );
    const { body, query } = build(docJson, [entry("e1", "長谷部")]);
    expect(query).toBe(buildSparseQuery(TAIL, body));
  });

  it("2 字のカタカナ名・漢字名は入らない（3 字未満）", () => {
    const { body, query } = build(docText("リオと朱音が並んだ。"), [
      entry("e1", "リオ"),
      entry("e2", "朱音"),
    ]);
    // 3 字以上の語が無いので従来の query に戻る。
    expect(query).toBe(buildSparseQuery(TAIL, body));
    expect(query.split(/\s+/)).not.toContain("朱音");
  });

  it("別名での言及は正式名を入れ、2 字の別名そのものは入らない", () => {
    const { query } = build(docText("千尋は窓を開けた。"), [
      entry("e1", "藤原千尋", { aliases: ["千尋"] }),
    ]);
    expect(query).toBe("藤原千尋");
  });

  it("除外の別名だけの言及では項目が入らない", () => {
    const { body, query } = build(docText("千尋の谷を見下ろした。"), [
      entry("e1", "藤原千尋", { aliases: ["千尋"], excluded: ["千尋の谷"] }),
    ]);
    expect(query).not.toContain("藤原千尋");
    expect(query).toBe(buildSparseQuery(TAIL, body));
  });

  it("除外の別名と同じ表記は、言及された項目の語に出さない", () => {
    const { query } = build(docText("長谷部は笑った。"), [
      entry("e1", "長谷部", {
        aliases: ["長谷部殿", "はせべ様"],
        excluded: ["長谷部殿"],
      }),
    ]);
    expect(query.split(" ")).toEqual(["長谷部", "はせべ様"]);
  });

  it("短い別名による言及も数える（(i)：一致を長さで絞らない）", () => {
    const { query } = build(docText("大地が揺れた。"), [
      entry("e1", "山田大地", { aliases: ["大地"] }),
    ]);
    expect(query).toBe("山田大地");
  });

  it("境界：本文「アリアナ」では Codex の「アリア」は入らず、カタカナの seed「アリアナ」が入る", () => {
    const { query } = build(docText("アリアナは歌った。"), [
      entry("e1", "アリア"),
    ]);
    expect(query.split(" ")).toEqual(["アリアナ"]);
  });

  it("全種類（item・lore・ユーザーが足した種類）の Codex が入る", () => {
    const { query } = build(docText("聖剣ルミナと星詠みの儀と天空艦隊。"), [
      entry("e1", "聖剣ルミナ", { type: "item" }),
      entry("e2", "星詠みの儀", { type: "lore" }),
      entry("e3", "天空艦隊", { type: "faction-custom" }),
    ]);
    // Codex の 3 項目が先、名前の一部のカタカナ「ルミナ」は seed として後ろに続く。
    expect(query.split(" ")).toEqual([
      "聖剣ルミナ",
      "星詠みの儀",
      "天空艦隊",
      "ルミナ",
    ]);
  });

  it("並び：一致回数の多い順、同数は最初の位置が早い順。Codex が先でカタカナが後、重複は 1 回", () => {
    const { query } = build(
      docText(
        "鳴神響が立つ。長谷部は笑う。長谷部と千尋。アリアとセレネスが来た。",
      ),
      [
        entry("e1", "長谷部"),
        entry("e2", "藤原千尋", { aliases: ["千尋"] }),
        entry("e3", "鳴神響"),
        entry("e4", "アリア"),
      ],
    );
    expect(query.split(" ")).toEqual([
      "長谷部",
      "鳴神響",
      "藤原千尋",
      "アリア",
      "セレネス",
    ]);
  });

  it("1 項目 3 語まで（名前を先に、別名は登録順）。ほかの項目の名前は残る", () => {
    const aliases = Array.from({ length: 10 }, (_, i) => `長谷部${i}号`);
    const { query } = build(
      docText("長谷部は笑う。長谷部が来る。鳴神響も来た。"),
      [entry("e1", "長谷部", { aliases }), entry("e2", "鳴神響")],
    );
    expect(query.split(" ")).toEqual([
      "長谷部",
      "長谷部0号",
      "長谷部1号",
      "鳴神響",
    ]);
  });

  it("全体 8 語まで（Codex 由来）", () => {
    const names = [
      "甲斐田一",
      "乙部二郎",
      "丙野三郎",
      "丁原四郎",
      "戊川五郎",
      "己島六郎",
      "庚田七郎",
      "辛木八郎",
      "壬生九郎",
    ];
    const { query } = build(
      docText(names.map((name) => `${name}が来た。`).join("")),
      names.map((name, i) => entry(`e${i}`, name)),
    );
    expect(query.split(" ")).toEqual(names.slice(0, 8));
  });

  it("2 字の語は落としてから 8 件（頻度の高い 2 字のカタカナ seed が枠を使わない）", () => {
    const words = [
      "アルファ",
      "ブラボー",
      "チャーリー",
      "デルタン",
      "エコーズ",
      "フォックス",
      "ゴルフィ",
      "ホテルズ",
      "インディア",
    ];
    const body = `${"リオと".repeat(5)}${"ミナと".repeat(5)}${words.join("と")}。`;
    const { query } = build(docText(body));
    expect(query.split(" ")).toEqual(words.slice(0, 8));
  });

  it("空白を含む名前（半角・全角）は分けた結果が 2 字なので入らない", () => {
    const { body, query } = build(docText("山田 太郎と鈴木　次郎が来た。"), [
      entry("e1", "山田 太郎"),
      entry("e2", "鈴木　次郎"),
    ]);
    expect(query).toBe(buildSparseQuery(TAIL, body));
  });

  it("Codex が 0 件ならカタカナの seed だけ", () => {
    const { query } = build(docText("セレネスは塔へ。セレネスは笑う。"));
    expect(query).toBe("セレネス");
  });

  it("3 字以上の語が無い本文は buildSparseQuery と同じ文字列（空を返さない）", () => {
    const { body, query } = build(docText("きょうはあめ。リオがきた。"));
    expect(query).toBe(buildSparseQuery(TAIL, body));
    expect(query).not.toBe("");
  });

  it("カタカナの seed はルビを含む照合用の本文から取る", () => {
    const docJson = docOf(
      paragraph(
        { type: "ruby", attrs: { base: "セレネス", annotation: "せれねす" } },
        text("は振り返った。"),
      ),
    );
    const { query } = build(docJson);
    expect(query).toBe("セレネス");
  });
});

describe("buildRelatedScenesSparseQuery：壊れた docJson", () => {
  it.each([
    ["JSON でない", "{not json"],
    ["空文字", ""],
    ["null", "null"],
    ["配列", "[1,2]"],
    ["content が配列でない", JSON.stringify({ type: "doc", content: "x" })],
  ])("%s でも例外を投げず、body で照合する", (_label, docJson) => {
    const body = "長谷部は笑った。セレネスも。";
    const run = () =>
      buildRelatedScenesSparseQuery({
        tailQuery: TAIL,
        body,
        docJson,
        language: "ja",
        codexTargets: [entry("e1", "長谷部")],
      });
    expect(run).not.toThrow();
    const query = run();
    // "content が配列でない" は JSON として読めるので照合用の本文は空になり、従来の query に戻る。
    if (docJson.startsWith('{"type"')) {
      expect(query).toBe(buildSparseQuery(TAIL, body));
    } else {
      expect(query).toBe("長谷部 セレネス");
    }
  });

  it("壊れた子 node（null・文字列）は飛ばす", () => {
    const docJson = JSON.stringify({
      type: "doc",
      content: [null, "x", paragraph(null, text("長谷部は笑った。"))],
    });
    const { query } = build(docJson, [entry("e1", "長谷部")]);
    expect(query).toBe("長谷部");
  });
});

describe("buildRelatedScenesSparseQuery: matcher の使い回し", () => {
  it("同じ配列では同じ結果を返し、新しい配列の Codex の変更は反映する", () => {
    const docJson = docText("長谷部は藤原千尋に会った。");
    const targets = [entry("e1", "長谷部")];
    expect(build(docJson, targets).query).toBe("長谷部");
    // 同じ配列で 2 回目（使い回した matcher が状態を持ち越さない）
    expect(build(docJson, targets).query).toBe("長谷部");
    // store の更新は新しい配列になる。足した項目は反映される
    const next = [...targets, entry("e2", "藤原千尋")];
    expect(build(docJson, next).query).toBe("長谷部 藤原千尋");
    // 古い配列は古い Codex のまま
    expect(build(docJson, targets).query).toBe("長谷部");
  });
});
