/**
 * AIのべりすと (.novel) ファイルフォーマット層。
 *
 * `<|endofsection|>` 区切りの UTF-8 plain text。文字列レベルの parse/build のみを
 * 担当し、ProseMirror / DB には依存しない（import 側・export 側で共有）。
 *
 * セクション順（非公式仕様 + サンプル実測。バージョンにより 11 個目以降に
 * UUID・保存時間などが続くことがある）:
 *   0 本文（改行は `<br>`） / 1 メモリ / 2 脚注 / 3 パラメータ /
 *   4 キャラクターブック（`タグ<|entry|>内容<|entry|>…` 交互ペア） /
 *   5 禁止ワード / 6 タイトル / 7 作品ID / 8 スクリプト / 9 チャットテンプレート
 */

import i18next from "@/lib/i18n";

export const NOVEL_SECTION_SEP = "<|endofsection|>";
export const NOVEL_ENTRY_SEP = "<|entry|>";

export interface NovelCharBookEntry {
  /** カンマ/スペース/`|` 区切りを分解したタグ列（先頭がメイン名の慣習）。 */
  tags: string[];
  /** 説明文（生改行を含む raw 文字列。`[...]` ブラケットは外していない）。 */
  content: string;
}

export interface NovelFile {
  /** 本文（`<br>` エンコードのまま）。 */
  body: string;
  memory: string;
  footnote: string;
  /** パラメータ（取り込まないが round-trip のため raw 保持）。 */
  params: string;
  charBook: NovelCharBookEntry[];
  /** キャラクターブックの raw セクション文字列（round-trip 用）。 */
  charBookRaw: string;
  bannedWords: string;
  title: string;
  workId: string;
  script: string;
  chatTemplate: string;
  /** 11 個目以降のセクション（UUID・保存時間など、バージョン依存）。 */
  extraSections: string[];
}

export interface NovelParseResult {
  novel: NovelFile;
  warnings: string[];
}

/** Parse a .novel file. BOM 除去・CRLF→LF 正規化・セクション欠落耐性あり。 */
export function parseNovelFile(text: string): NovelParseResult {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sections = normalized.split(NOVEL_SECTION_SEP);
  const at = (i: number): string => sections[i] ?? "";

  const charBookRaw = at(4);
  const { entries, warnings } = parseCharBook(charBookRaw);

  return {
    novel: {
      body: at(0),
      memory: at(1),
      footnote: at(2),
      params: at(3),
      charBook: entries,
      charBookRaw,
      bannedWords: at(5),
      title: at(6),
      workId: at(7),
      script: at(8),
      chatTemplate: at(9),
      extraSections: sections.slice(10),
    },
    warnings,
  };
}

/**
 * Parse the character book section: `タグ<|entry|>内容<|entry|>…`（末尾にも
 * `<|entry|>` が付く）。タグと内容の交互ペア。
 */
export function parseCharBook(section: string): {
  entries: NovelCharBookEntry[];
  warnings: string[];
} {
  const entries: NovelCharBookEntry[] = [];
  const warnings: string[] = [];
  if (!section.trim()) return { entries, warnings };

  const parts = section.split(NOVEL_ENTRY_SEP);
  // 末尾セパレータ由来の空要素を 1 つだけ落とす（内容が本当に空のペアは保持）。
  if (parts.length % 2 === 1 && parts[parts.length - 1]!.trim() === "") {
    parts.pop();
  }

  for (let i = 0; i < parts.length; i += 2) {
    const tagField = parts[i]!;
    const content = parts[i + 1];
    const tags = splitCharBookTags(tagField);
    if (content === undefined) {
      // 奇数余り: タグだけのエントリとして取り込み、警告を出す。
      if (tags.length > 0) {
        entries.push({ tags, content: "" });
      }
      warnings.push(
        i18next.t("import.novel.warnings.tagNoContent", {
          tag: tagField.trim(),
        }),
      );
      continue;
    }
    if (tags.length === 0) {
      warnings.push(i18next.t("import.novel.warnings.tagEmpty"));
      continue;
    }
    entries.push({ tags, content });
  }

  return { entries, warnings };
}

/** タグ欄をカンマ（半角/全角）・スペース・`|` で分解する。 */
export function splitCharBookTags(field: string): string[] {
  return field
    .split(/[,、|\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * 外周 1 組の `[...]` ブラケット（AIのべりすとの「本文ではない」マーカー）を外す。
 * `[A] と [B]` のように先頭 `[` が末尾 `]` と対応しない場合は外さない
 * （深さが途中で 0 に戻る = 外周ラッパーではない）。
 */
export function stripBracketWrapper(content: string): string {
  const trimmed = content.trim();
  if (
    !(trimmed.startsWith("[") && trimmed.endsWith("]") && trimmed.length >= 2)
  ) {
    return trimmed;
  }
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0 && i < trimmed.length - 1) return trimmed;
    }
  }
  return trimmed.slice(1, -1).trim();
}

/** NovelFile を 10+ セクションの .novel 文字列に組み立てる。 */
export function buildNovelFile(novel: NovelFile): string {
  const charBookSection =
    novel.charBook.length > 0
      ? novel.charBook
          .map((e) => `${e.tags.join(", ")}${NOVEL_ENTRY_SEP}${e.content}`)
          .join(NOVEL_ENTRY_SEP) + NOVEL_ENTRY_SEP
      : "";

  const sections = [
    novel.body,
    novel.memory,
    novel.footnote,
    novel.params,
    charBookSection,
    novel.bannedWords,
    novel.title,
    novel.workId,
    novel.script,
    novel.chatTemplate,
    ...novel.extraSections,
  ];
  return sections.join(NOVEL_SECTION_SEP);
}

/**
 * Raw セクション文字列を使った完全 round-trip 用ビルド。charBook の再組み立て
 * では空白/区切り文字が正規化されるため、入力をそのまま温存したい場合はこちら。
 */
export function buildNovelFileRaw(novel: NovelFile): string {
  const sections = [
    novel.body,
    novel.memory,
    novel.footnote,
    novel.params,
    novel.charBookRaw,
    novel.bannedWords,
    novel.title,
    novel.workId,
    novel.script,
    novel.chatTemplate,
    ...novel.extraSections,
  ];
  return sections.join(NOVEL_SECTION_SEP);
}

/** フォーマット制御トークンを除去する（全ペイロード共通の最低限サニタイズ）。 */
export function sanitizeNovelText(s: string): string {
  return s.split(NOVEL_SECTION_SEP).join("").split(NOVEL_ENTRY_SEP).join("");
}

/**
 * 本文 1 行のサニタイズ。リテラル `<br>` は再インポート時に改行化される事故を
 * 防ぐため全角表記に逃がす。
 */
export function sanitizeNovelBodyLine(s: string): string {
  return sanitizeNovelText(s).replace(/<br\s*\/?>/gi, "＜br＞");
}

/**
 * キャラクターブックのタグ 1 個のサニタイズ。
 *
 * この形式のタグ欄はカンマ（半角/全角）・空白（全角含む）・`|` がすべて
 * 区切り文字で、タグ内に区切り文字を含める手段が無い。区切り文字は
 * `splitCharBookTags` と同じ文字クラスでまとめて中黒 `・` に置換し、
 * 「メアリー スミス」のような名前が再インポートで複数タグに分裂しない
 * 単一トークンへ正規化する（lossy だが構造は保たれる）。
 */
export function sanitizeCharBookTag(s: string): string {
  return sanitizeNovelText(s)
    .trim()
    .replace(/[,、|\s]+/g, "・");
}
