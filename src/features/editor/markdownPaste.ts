import type { Editor } from "@tiptap/core";
import { DOMParser as PMDOMParser, Fragment, Slice } from "@tiptap/pm/model";

/**
 * 貼り付けた Markdown を本文に取り込むためのユーティリティ。
 *
 * - 通常ペースト (Ctrl/Cmd+V): `insertMarkdownAsUnknown` で Markdown を
 *   リッチノードに変換し、挿入範囲に `source:"unknown"` 帰属を付与する。
 * - 書式設定なしペースト (Ctrl/Cmd+Shift+V): `markdownToPlainText` で
 *   Markdown 記法を除去したプレーンテキストにしてから挿入する。
 *
 * 変換は tiptap-markdown の `editor.storage.markdown.parser` を正本に使う
 * (clipboardTextParser と同じ inline 解釈)。これにより手打ち InputRules と
 * 同じレンダリング結果が貼り付けでも得られる。
 */

// tiptap-markdown の elementFromString を踏襲: <body> でラップして DOM 化する。
function elementFromString(html: string): HTMLElement {
  return new window.DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  ).body;
}

interface MarkdownStorage {
  parser?: { parse: (content: string, opts?: { inline?: boolean }) => string };
}

function getMarkdownParser(editor: Editor) {
  const storage = (
    editor.storage as unknown as Record<string, unknown> | undefined
  )?.["markdown"] as MarkdownStorage | undefined;
  return storage?.parser ?? null;
}

/**
 * Markdown テキストを ProseMirror Slice に変換する。
 * tiptap-markdown の clipboardTextParser と同じ `inline:true` 解釈を使う
 * (単一段落は unwrap され、見出し/リスト等のブロックは保持される)。
 */
export function parseMarkdownToSlice(
  editor: Editor,
  text: string,
): Slice | null {
  const parser = getMarkdownParser(editor);
  if (!parser) return null;
  try {
    const html = parser.parse(text, { inline: true });
    return PMDOMParser.fromSchema(editor.schema).parseSlice(
      elementFromString(html),
      { preserveWhitespace: true, context: editor.state.selection.$from },
    );
  } catch {
    return null;
  }
}

/**
 * Markdown 記法を除去したプレーンテキストを返す (書式設定なしペースト用)。
 * 一旦 Markdown を解析して DOM/ノードにし、ブロック区切りを改行にした
 * テキストを取り出すことで、`#` `*` `-` 等のマーカーを確実に落とす。
 */
export function markdownToPlainText(editor: Editor, text: string): string {
  const parser = getMarkdownParser(editor);
  if (!parser) return text;
  try {
    const html = parser.parse(text, { inline: false });
    const node = PMDOMParser.fromSchema(editor.schema).parse(
      elementFromString(html),
    );
    // ブロック境界は改行に、hardBreak (<br>) も改行に落とす
    // (leafText="" のままだと "行1<br>行2" が "行1行2" に潰れる)。
    return node.textBetween(0, node.content.size, "\n", (leaf) =>
      leaf.type.name === "hardBreak" ? "\n" : "",
    );
  } catch {
    return text;
  }
}

/**
 * Slice を現在の選択位置に挿入し、挿入範囲に `source:"unknown"` 帰属マークを
 * 付与する共通処理。`programmaticInsert` メタを立てて AiEditedPlugin による
 * 帰属マーク除去を回避する (provenance 契約の維持)。schema に authorship が
 * 無いエディタ (file-backed 等) では帰属付与をスキップし、挿入のみ行う。
 * 配置不能で no-op だった場合は false を返す (呼び出し側が fallback)。
 */
function insertSliceWithUnknown(editor: Editor, slice: Slice | null): boolean {
  if (!slice || slice.size === 0) return false;

  const now = new Date().toISOString();
  const from = editor.state.selection.from;
  const authorshipType = editor.schema.marks["authorship"];

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      tr.replaceSelection(slice);
      if (!tr.docChanged) return false;
      const insertedTo = tr.selection.from;
      if (authorshipType && insertedTo > from) {
        tr.addMark(
          from,
          insertedTo,
          authorshipType.create({
            source: "unknown",
            timestamp: now,
            originalLength: insertedTo - from,
            model: null,
            chatMessageId: null,
          }),
        );
      }
      return true;
    })
    .run();
}

/**
 * Markdown を変換して挿入し、挿入範囲に `source:"unknown"` 帰属を付与する。
 * 変換できなければ false を返す (呼び出し側が生テキスト挿入にフォールバック)。
 */
export function insertMarkdownAsUnknown(editor: Editor, text: string): boolean {
  return insertSliceWithUnknown(editor, parseMarkdownToSlice(editor, text));
}

/**
 * プレーンテキストを段落単位 (改行で分割) で Slice 化する。
 * `insertFromPaste` の複数段落分岐と同じ openStart/openEnd=1 で、先頭段落は
 * カーソル位置の段落に、末尾段落は後続の残りにマージされる。
 */
function plainTextToSlice(editor: Editor, text: string): Slice | null {
  const { schema } = editor;
  const paragraphType = schema.nodes["paragraph"];
  if (!paragraphType) return null;
  const lines = text.split("\n");
  const nodes = lines.map((line) =>
    line
      ? paragraphType.create(null, schema.text(line))
      : paragraphType.create(),
  );
  return new Slice(Fragment.fromArray(nodes), 1, 1);
}

/**
 * プレーンテキストを挿入し、挿入範囲に `source:"unknown"` 帰属を付与する
 * (書式設定なしペースト / 変換フォールバック用、エディタ非依存)。
 */
export function insertPlainTextAsUnknown(
  editor: Editor,
  text: string,
): boolean {
  return insertSliceWithUnknown(editor, plainTextToSlice(editor, text));
}

/**
 * 現在の選択位置が verbatim (コードブロック等 `spec.code` ノード) 内かどうか。
 * code ノードは inline mark を許可せず、Markdown 変換も不適切 (コードは逐語)。
 */
function isVerbatimContext(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.spec.code) return true;
  }
  return false;
}

/**
 * 原文テキストをそのまま (変換・マークなしで) 挿入する。コードブロック内
 * ペースト用 — `\n` も含めて逐語で入る。
 */
function insertVerbatimText(editor: Editor, text: string): void {
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      tr.insertText(text);
      return true;
    })
    .run();
}

// --- 書式設定なしペースト (Ctrl/Cmd+Shift+V) の検出フラグ ---
//
// クリップボード API の同期読み取りは権限・user-gesture 制約があるため、
// keydown で「次の paste は書式なし」と arm し、native paste イベントが
// 配信するクリップボードデータを handlePaste 側で strip して使う。

let plainPasteArmed = false;

/** keydown イベントが Mod(+Ctrl/Cmd)+Shift+V かどうか。 */
export function isPlainPasteCombo(event: KeyboardEvent): boolean {
  const isV = event.key === "v" || event.key === "V";
  return (
    isV &&
    event.shiftKey === true &&
    (event.metaKey === true || event.ctrlKey === true)
  );
}

/** 次の paste を「書式設定なし」として扱うよう arm する。 */
export function armPlainPaste(): void {
  plainPasteArmed = true;
}

/** arm 済みなら true を返し、フラグを消費 (リセット) する。 */
export function consumePlainPaste(): boolean {
  const armed = plainPasteArmed;
  plainPasteArmed = false;
  return armed;
}

/**
 * keydown を受けて書式なしペーストの arm 状態を更新する。
 * - Mod+Shift+V なら arm。
 * - それ以外のキーなら arm を解除する (paste が来なかった場合の stale 解除)。
 *
 * タイマーを使わずキーイベントだけで解除するため、直後の通常 Ctrl+V でも
 * その keydown 列 (modifier/v) が stale flag を確実に消す。
 */
export function notePlainPasteKeyDown(event: KeyboardEvent): void {
  if (isPlainPasteCombo(event)) {
    plainPasteArmed = true;
  } else {
    plainPasteArmed = false;
  }
}

/**
 * 外部プレーンテキスト貼り付け (handlePaste Case 3) の分岐。
 * - `plain` が true (書式設定なし) なら Markdown 記法を除去して `insertRaw`。
 * - 通常は Markdown を変換して unknown 帰属で挿入する。
 * - 変換できなければ生テキストで `insertRaw` にフォールバック。
 *
 * `plain` フラグの消費 (consumePlainPaste) は呼び出し側 (handlePaste) が
 * paste 種別に関わらず必ず行う。ここはフラグの値だけを受け取る純関数とし、
 * arm が次の paste に漏れないようにする。
 * `insertRaw` は呼び出し側が持つ生テキスト挿入 (source:"unknown") を渡す。
 */
export function pasteExternalText(
  editor: Editor,
  plainText: string,
  insertRaw: (text: string) => void,
  plain: boolean,
): void {
  // コードブロック等 verbatim コンテキストでは変換せず原文を逐語挿入する
  // (code ノードは mark 不可で、変換すると構造破壊・帰属の部分付与が起きる)。
  if (isVerbatimContext(editor)) {
    insertVerbatimText(editor, plainText);
    return;
  }
  if (plain) {
    // ブロック専用記法 (`---` 水平線など) は textBetween が空文字を返す。
    // そのまま挿入すると貼り付けが無音で消えるため、空なら原文を挿入する。
    const stripped = markdownToPlainText(editor, plainText);
    insertRaw(stripped || plainText);
    return;
  }
  if (insertMarkdownAsUnknown(editor, plainText)) return;
  insertRaw(plainText);
}

/**
 * Linear / file-backed エディタ共通の外部テキスト paste ハンドラ。
 * editorProps.handlePaste / PasteSanitizer plugin から委譲して使う。
 * - 内部コピー (grimodex/pm-slice) は false を返し ProseMirror 既定処理に委ねる
 * - 書式なしフラグを消費し、必要なら `sanitize` を変換前に適用して `pasteExternalText`
 * - 挿入は渡された `editor` に対して行う (ペイン別ルーティング)
 * 処理したら true、対象外なら false を返す。
 */
export function handleExternalPaste(
  editor: Editor | null,
  event: ClipboardEvent,
  opts: { sanitize?: (text: string) => string } = {},
): boolean {
  const html = event.clipboardData?.getData("text/html");
  if (
    html &&
    (html.includes("data-grimodex-source") || html.includes("data-pm-slice"))
  ) {
    return false;
  }
  const wantPlain = consumePlainPaste();
  const plainText = event.clipboardData?.getData("text/plain") ?? "";
  if (!plainText || !editor) return false;
  const text = opts.sanitize ? opts.sanitize(plainText) : plainText;
  pasteExternalText(
    editor,
    text,
    (t) => insertPlainTextAsUnknown(editor, t),
    wantPlain,
  );
  return true;
}
