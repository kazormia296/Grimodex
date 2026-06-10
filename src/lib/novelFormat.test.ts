import { describe, expect, it } from "vitest";
import {
  NOVEL_ENTRY_SEP,
  NOVEL_SECTION_SEP,
  buildNovelFile,
  buildNovelFileRaw,
  parseCharBook,
  parseNovelFile,
  sanitizeCharBookTag,
  sanitizeNovelBodyLine,
  sanitizeNovelText,
  splitCharBookTags,
  stripBracketWrapper,
} from "./novelFormat";
import sampleRaw from "./novelFormat.sample.novel?raw";

// novelFormat.sample.novel（AIのべりすと実出力）の転写。
// 各欄に欄名・操作説明を入力した自己文書化サンプル。
const SAMPLE_BODY =
  "本文<br>本文2行目<br>本文3行目<br><br>↑改行のみの行<br><br><br><br>↑改行のみの3行";
const SAMPLE_MEMORY = "メモリ(長期記憶)入力欄";
const SAMPLE_FOOTNOTE = [
  "脚注／システムメッセージ",
  "優先度の高いメモリです。",
  "常に守らせたい指示や、関連タグ、ジャンルや現在の状況を入力します。",
  "チャットボットにおけるシステムメッセージのような効果を及ぼします。",
  "例:ワーズの一人称で、ポップなコメディとして書いて。",
  "例:[著者:森陽外。ジャンル:コメディ]",
  "例: デリダはエンドゥの背中に乗っている。エンドゥは飛んでい",
].join("\n");
const SAMPLE_CHARBOOK_CONTENT_1 = [
  "",
  "[",
  "(説明用の文章を入力欄に手入力)",
  "概要",
  "タグはカンマ()、スペースまたは|で区切って複数指定することができます。",
  "説明には必ずタグ付けしたいキャラクターの名前や用語名までを含めてください。適度に「名前」+「:」を繰り返すことでAIに名前と説明文を強く関連付けることができます。",
  "",
  "ブラケット[]で囲んだ文章は、AIに本文ではないと認識されます。",
  "]",
  "",
].join("\n");
const SAMPLE_CHARBOOK_CONTENT_2 = [
  "[",
  "入力例",
  "トリン:女性。スフィアの神様。ワーズの姉。10代。トリン:心配",
  "事があると髪の毛が伸びる。「うん? 私にも何か大切なシゴトがあ",
  "ったような .. 」トリンの好物はチョコレートケーキ。]",
].join("\n");
const SAMPLE_CHARBOOK =
  `tag1${NOVEL_ENTRY_SEP}${SAMPLE_CHARBOOK_CONTENT_1}` +
  `${NOVEL_ENTRY_SEP}tag2, test1${NOVEL_ENTRY_SEP}${SAMPLE_CHARBOOK_CONTENT_2}${NOVEL_ENTRY_SEP}`;
const SAMPLE_BANNED = [
  "改行またはく<>>で区切ってください。\\nで改行文字、\\tでタブ文字が指定できます。",
  "銃",
  "ナイフ",
].join("\n");
const SAMPLE_TITLE = "タイトル入力欄";
const SAMPLE_CHAT_TEMPLATE = "チャットテンプレート入力欄";

const SAMPLE = [
  SAMPLE_BODY,
  SAMPLE_MEMORY,
  SAMPLE_FOOTNOTE,
  "", // パラメータ
  SAMPLE_CHARBOOK,
  SAMPLE_BANNED,
  SAMPLE_TITLE,
  "", // 作品ID
  "", // スクリプト
  SAMPLE_CHAT_TEMPLATE,
].join(NOVEL_SECTION_SEP);

describe("parseNovelFile", () => {
  it("転写定数は実ファイル fixture と完全一致する", () => {
    expect(SAMPLE).toBe(sampleRaw);
  });

  it("サンプルの 10 セクションを正しく割り付ける", () => {
    const { novel, warnings } = parseNovelFile(SAMPLE);
    expect(novel.body).toBe(SAMPLE_BODY);
    expect(novel.memory).toBe(SAMPLE_MEMORY);
    expect(novel.footnote).toBe(SAMPLE_FOOTNOTE);
    expect(novel.params).toBe("");
    expect(novel.bannedWords).toBe(SAMPLE_BANNED);
    expect(novel.title).toBe(SAMPLE_TITLE);
    expect(novel.workId).toBe("");
    expect(novel.script).toBe("");
    expect(novel.chatTemplate).toBe(SAMPLE_CHAT_TEMPLATE);
    expect(novel.extraSections).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("キャラクターブックをタグ/内容ペアに分解する", () => {
    const { novel } = parseNovelFile(SAMPLE);
    expect(novel.charBook).toHaveLength(2);
    expect(novel.charBook[0]).toEqual({
      tags: ["tag1"],
      content: SAMPLE_CHARBOOK_CONTENT_1,
    });
    expect(novel.charBook[1]).toEqual({
      tags: ["tag2", "test1"],
      content: SAMPLE_CHARBOOK_CONTENT_2,
    });
  });

  it("先頭 BOM を除去する", () => {
    const { novel } = parseNovelFile("﻿" + SAMPLE);
    expect(novel.body).toBe(SAMPLE_BODY);
  });

  it("CRLF を LF に正規化する", () => {
    const { novel } = parseNovelFile(SAMPLE.replace(/\n/g, "\r\n"));
    expect(novel.footnote).toBe(SAMPLE_FOOTNOTE);
  });

  it("セクションが欠落していても空文字として扱う", () => {
    const { novel } = parseNovelFile(
      ["本文だけ", "メモリ", "脚注", "", "tag1<|entry|>内容<|entry|>"].join(
        NOVEL_SECTION_SEP,
      ),
    );
    expect(novel.body).toBe("本文だけ");
    expect(novel.charBook).toHaveLength(1);
    expect(novel.title).toBe("");
    expect(novel.chatTemplate).toBe("");
    expect(novel.extraSections).toEqual([]);
  });

  it("11 個目以降のセクション（UUID 等）を extraSections に保持する", () => {
    const input =
      SAMPLE +
      NOVEL_SECTION_SEP +
      "some-uuid" +
      NOVEL_SECTION_SEP +
      "2026-06-10";
    const { novel } = parseNovelFile(input);
    expect(novel.extraSections).toEqual(["some-uuid", "2026-06-10"]);
  });
});

describe("parseCharBook", () => {
  it("空セクションは 0 件", () => {
    expect(parseCharBook("").entries).toEqual([]);
    expect(parseCharBook("  \n").entries).toEqual([]);
  });

  it("奇数余りのタグは内容空エントリとして取り込み警告する", () => {
    const { entries, warnings } = parseCharBook(
      `tag1${NOVEL_ENTRY_SEP}内容1${NOVEL_ENTRY_SEP}余りタグ`,
    );
    expect(entries).toEqual([
      { tags: ["tag1"], content: "内容1" },
      { tags: ["余りタグ"], content: "" },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("タグが空のエントリはスキップして警告する", () => {
    const { entries, warnings } = parseCharBook(
      ` ${NOVEL_ENTRY_SEP}内容だけ${NOVEL_ENTRY_SEP}`,
    );
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("内容が空文字のペアは保持する", () => {
    const { entries } = parseCharBook(`tag1${NOVEL_ENTRY_SEP}`);
    expect(entries).toEqual([{ tags: ["tag1"], content: "" }]);
  });
});

describe("splitCharBookTags", () => {
  it("カンマ・全角カンマ・スペース・| で分解する", () => {
    expect(splitCharBookTags("a, b、c|d e　f")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("空欄は空配列", () => {
    expect(splitCharBookTags("  ")).toEqual([]);
  });
});

describe("stripBracketWrapper", () => {
  it("外周 1 組のブラケットを外す", () => {
    expect(stripBracketWrapper("[ 説明文 ]")).toBe("説明文");
  });

  it("内側のブラケットは温存する", () => {
    expect(stripBracketWrapper("[a[b]c]")).toBe("a[b]c");
  });

  it("ブラケットなしは trim のみ", () => {
    expect(stripBracketWrapper(" 説明 ")).toBe("説明");
  });

  it("先頭 [ と末尾 ] が対応しない場合は外さない", () => {
    expect(stripBracketWrapper("[A] と [B]")).toBe("[A] と [B]");
    expect(stripBracketWrapper("[補足]\n本文。\n[補足2]")).toBe(
      "[補足]\n本文。\n[補足2]",
    );
  });

  it("サンプルの複数行コンテンツからブラケットを外す", () => {
    const inner = stripBracketWrapper(SAMPLE_CHARBOOK_CONTENT_2);
    expect(inner.startsWith("入力例")).toBe(true);
    expect(inner.endsWith("トリンの好物はチョコレートケーキ。")).toBe(true);
  });
});

describe("buildNovelFile / buildNovelFileRaw", () => {
  it("raw round-trip: parse → buildNovelFileRaw が入力と完全一致する", () => {
    const { novel } = parseNovelFile(SAMPLE);
    expect(buildNovelFileRaw(novel)).toBe(SAMPLE);
  });

  it("再組み立て round-trip: サンプルはタグ正規化後も一致する", () => {
    const { novel } = parseNovelFile(SAMPLE);
    expect(buildNovelFile(novel)).toBe(SAMPLE);
  });

  it("charBook 空のときキャラクターブックセクションは空文字", () => {
    const { novel } = parseNovelFile("本文");
    const built = buildNovelFile(novel);
    expect(built.split(NOVEL_SECTION_SEP)[4]).toBe("");
  });

  it("10 セクション構成で出力される", () => {
    const { novel } = parseNovelFile("本文");
    expect(buildNovelFile(novel).split(NOVEL_SECTION_SEP)).toHaveLength(10);
  });
});

describe("sanitize", () => {
  it("sanitizeNovelText は制御トークンを除去する", () => {
    expect(sanitizeNovelText("a<|endofsection|>b<|entry|>c")).toBe("abc");
  });

  it("sanitizeNovelBodyLine はリテラル <br> を全角に逃がす", () => {
    expect(sanitizeNovelBodyLine("a<br>b<BR/>c<br />d")).toBe(
      "a＜br＞b＜br＞c＜br＞d",
    );
  });

  it("sanitizeCharBookTag は区切り文字をすべて中黒に正規化する", () => {
    expect(sanitizeCharBookTag("赤井 秀一,FBI|狙撃手")).toBe(
      "赤井・秀一・FBI・狙撃手",
    );
    expect(sanitizeCharBookTag("a<|entry|>b")).toBe("ab");
    expect(sanitizeCharBookTag(" メアリー　スミス ")).toBe("メアリー・スミス");
  });

  it("sanitizeCharBookTag の出力は splitCharBookTags で単一トークンに保たれる", () => {
    // escape 先が区切り文字だと export → import の往復で name/aliases が
    // 分裂する（過去バグ）。区切り文字クラス全体に対して固定する。
    for (const raw of [
      "メアリー スミス",
      "山田　太郎",
      "FBI,捜査官",
      "a、b",
      "x|y z",
    ]) {
      const tag = sanitizeCharBookTag(raw);
      expect(splitCharBookTags(tag)).toEqual([tag]);
    }
  });
});
