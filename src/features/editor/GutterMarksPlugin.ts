import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Fragment, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";

import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { ANNOTATION_REBUILD_META } from "@/features/post-effect/AnnotationPlugin";
import i18next from "@/lib/i18n";
import { markEnd, markStart } from "@/lib/perfLog";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { COMMENT_REBUILD_META } from "./CommentDecorationPlugin";
import { lintDecorationKey, LINT_REBUILD_META } from "./LintDecorationPlugin";

/**
 * 段落ガター記号 — コメント / 伏線 / 校閲の指摘を含むブロックの先頭に、
 * 「この段落に何かある」の当たりアイコンを描く widget decoration。
 *
 * デザイン(Editorパネル Refine 1e)の3チャネル整理に伴い、本文中の装飾
 * （点線・破線・波線）に加えて段落単位の当たりを付ける。行単位ではなく
 * ブロック単位に集約する（縦書き時は論理プロパティにより段落頭の上部
 * 余白へ自然に回る — デザインの縦書き注記と同じ挙動）。
 *
 * 実装は LintDisableGutterPlugin と同型: docChanged / 各レイヤーの
 * rebuild meta で全ブロックを walk し、1ブロック=1 widget に集約する。
 */
export const gutterMarksKey = new PluginKey<DecorationSet>("gutterMarks");

/** Meta key to force rebuild (dispatched when a layer toggle flips). */
export const GUTTER_REBUILD_META = "gutterMarks/rebuild";

export type GutterChannel = "comment" | "reader" | "foreshadow" | "review";

/** チャネル → 表示順。widget key にも同順で刻む。 */
const CHANNEL_ORDER: GutterChannel[] = [
  "comment",
  "reader",
  "foreshadow",
  "review",
];

const GUTTER_MARK_NAMES = new Set([
  "comment",
  "foreshadowSetup",
  "foreshadowPayoff",
  "peAnnotation",
]);

/** 9x9 の Lucide 相当アイコン (stroke=currentColor)。 */
const CHANNEL_ICON_PATHS: Record<GutterChannel, string> = {
  comment:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
  reader:
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"></path><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"></path>',
  foreshadow:
    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" x2="4" y1="22" y2="15"></line>',
  review: '<path d="m6 16 6-12 6 12"></path><path d="M8 12h8"></path>',
};

const CHANNEL_LABEL_KEYS: Record<GutterChannel, string> = {
  comment: "editor.gutter.comment",
  reader: "editor.gutter.reader",
  foreshadow: "editor.gutter.foreshadow",
  review: "editor.gutter.review",
};

/**
 * ブロック内に存在する（かつレイヤーONの）チャネルを収集する。
 *
 * `hasLint` は「このブロックの範囲に Lint 指摘 (lint-deco) があるか」。Lint は
 * mark ではなく decoration なので walk では拾えず、buildGutterDecorations が
 * LintDecorationPlugin の decoration set をブロック範囲で引いて渡す。校閲の
 * 指摘レイヤーは「校閲アノテーション + Lint」の統合 (LayersPopover と同義)
 * なので、どちらのソースでも同じ review ガター記号を出す。
 */
function collectChannels(
  node: ProseMirrorNode,
  hasLint: boolean,
): GutterChannel[] {
  const cursor = useCursorSettingsStore.getState();
  const { showAnnotations: showReview, showReaderComments } =
    useAnnotationStore.getState();

  let hasComment = false;
  let hasReader = false;
  let hasLiveReader = false;
  let hasForeshadow = false;
  let hasReview = false;

  node.descendants((child) => {
    if (hasComment && hasReader && hasForeshadow && hasReview) return false; // early exit
    for (const m of child.marks) {
      switch (m.type.name) {
        case "comment":
          hasComment = true;
          break;
        case "foreshadowSetup":
        case "foreshadowPayoff":
          hasForeshadow = true;
          break;
        case "peAnnotation":
          // pseudo_comment (読者コメント) は指摘ではなくコメント族の別チャネル
          if (m.attrs.status !== "dismissed") {
            if (m.attrs.category === "pseudo_comment") {
              hasReader = true;
              hasLiveReader ||= m.attrs.live === true;
            } else hasReview = true;
          }
          break;
      }
    }
    return true;
  });

  const channels: GutterChannel[] = [];
  if (hasComment && cursor.showComments) channels.push("comment");
  if (hasReader && (showReaderComments || hasLiveReader))
    channels.push("reader");
  if (hasForeshadow && cursor.showForeshadowMarks) channels.push("foreshadow");
  // 校閲の指摘 = 校閲アノテーション(showAnnotations) ∨ Lint(showLint)。
  // Lint 側は showLint OFF 時 decoration set が空なので hasLint も false に
  // なるが、意図を明示して二重ゲートしておく。
  const reviewFromAnnotation = hasReview && showReview;
  const reviewFromLint = hasLint && cursor.showLint;
  if (reviewFromAnnotation || reviewFromLint) channels.push("review");
  return channels;
}

/**
 * ガター行の inline-start 張り出し量（予約幅）。アイコン 14px × n + gap 2px ×
 * (n-1) に、アンカーからの逃げ 0.6em (.gutter-marks__row の inset-inline-end)
 * を足したもの。EditorContentArea がガター生成レイヤーON時に本文ラッパーへ
 * `--gutter-reserve` として供給し padding で予約する — EditorDropDiv の
 * p-4 (16px) だけでは狭幅時に張り出しがクリップされるため。
 */
export function gutterReserveInlineSize(channelCount: number): string | null {
  if (channelCount <= 0) return null;
  const px = channelCount * 14 + (channelCount - 1) * 2;
  return `calc(${px}px + 0.6em)`;
}

/** widget の DOM を生成する（テストから直接呼べるよう export）。 */
export function buildGutterWidgetDom(channels: GutterChannel[]): HTMLElement {
  const el = document.createElement("span");
  el.className = "gutter-marks";
  el.setAttribute("aria-hidden", "true");

  const row = document.createElement("span");
  row.className = "gutter-marks__row";
  el.appendChild(row);

  for (const channel of channels) {
    const icon = document.createElement("span");
    icon.className = `gutter-mark gutter-mark--${channel}`;
    icon.title = i18next.t(CHANNEL_LABEL_KEYS[channel]);
    icon.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${CHANNEL_ICON_PATHS[channel]}</svg>`;
    row.appendChild(icon);
  }
  return el;
}

function buildGutterDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  // LintDecorationPlugin の decoration set。Lint は mark ではなく decoration
  // なので、ブロックごとに範囲を引いて「指摘あり」を判定する。gutter が apply /
  // init 時に newState から最新の lint field を読めるのは、GutterMarksExtension を
  // 低 priority (extensions.ts) にして PM プラグイン適用順で lint より **後** に
  // 回しているから。TipTap は登録順を反転するので、単に「後から登録」では逆に
  // gutter が先に走り lint field が undefined になる (詳細は extensions.ts の注記)。
  // 万一 undefined でも `?? null` で無害に「Lint 指摘なし」扱いになる。
  const lintDecos = lintDecorationKey.getState(state)?.decos ?? null;
  state.doc.descendants((node, pos) => {
    // 最内の textblock (paragraph/heading 等) にのみ描く。blockquote/listItem/
    // tableCell などのコンテナ側にも描くと内側の段落と二重になる
    // (offsetMap の「nested block を持つブロックは自前テキストを出さない」
    // passthrough ガードと同じ理由)。sceneBeat は本文ではないので対象外。
    if (!node.isTextblock || node.type.name === "sceneBeat") return true;

    // ブロックのインライン内容範囲 [pos+1, pos+nodeSize-1] に lint-deco があるか。
    const hasLint =
      !!lintDecos &&
      lintDecos.find(pos + 1, pos + node.nodeSize - 1).length > 0;
    const channels = collectChannels(node, hasLint);
    if (channels.length === 0) return false;

    const ordered = CHANNEL_ORDER.filter((c) => channels.includes(c));
    decos.push(
      Decoration.widget(pos + 1, () => buildGutterWidgetDom(ordered), {
        side: -1,
        key: `gutter-${pos}-${ordered.join(".")}`,
      }),
    );
    // textblock の中に textblock は無いのでこれ以上潜らない
    return false;
  });
  return DecorationSet.create(state.doc, decos);
}

function fragmentHasGutterMark(fragment: Fragment): boolean {
  let found = false;
  fragment.descendants((node) => {
    if (node.marks.some((mark) => GUTTER_MARK_NAMES.has(mark.type.name))) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function rangeHasGutterMark(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): boolean {
  if (from >= to) return false;
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.marks.some((mark) => GUTTER_MARK_NAMES.has(mark.type.name))) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

/**
 * Plain text edits cannot change which gutter channels a textblock owns.
 * Preserve and map the existing widget set for those transactions so a
 * keystroke near the start of a long document does not destroy/recreate every
 * later widget merely because its absolute position shifted.
 *
 * Structural edits and edits carrying/removing gutter marks deliberately fall
 * back to the full rebuild. Those operations can split/merge marked blocks or
 * introduce/remove the last channel in a block.
 */
function canMapGutterDecorations(tr: Transaction): boolean {
  if (!tr.docChanged || tr.steps.length === 0) return true;

  return tr.steps.every((step, index) => {
    if (!(step instanceof ReplaceStep)) return false;

    const docBefore = tr.docs[index];
    const $from = docBefore.resolve(step.from);
    const $to = docBefore.resolve(step.to);
    if (!$from.sameParent($to) || !$from.parent.inlineContent) return false;

    let inlineOnly = true;
    step.slice.content.forEach((node) => {
      if (!node.isInline) inlineOnly = false;
    });
    if (!inlineOnly) return false;

    return (
      !fragmentHasGutterMark(step.slice.content) &&
      !rangeHasGutterMark(docBefore, step.from, step.to)
    );
  });
}

export function createGutterMarksPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: gutterMarksKey,
    state: {
      init(_config, state) {
        return buildGutterDecorations(state);
      },
      apply(tr, oldDecos, _oldState, newState) {
        markStart("plugin.gutterMarks.apply");
        try {
          const forced =
            tr.getMeta(GUTTER_REBUILD_META) === true ||
            tr.getMeta(COMMENT_REBUILD_META) === true ||
            tr.getMeta(ANNOTATION_REBUILD_META) === true ||
            // Lint 指摘の更新 (debounce 後の setLintDiagnostics = lintDecorationKey
            // meta) / showLint トグル (LINT_REBUILD_META) でも review ガターが
            // 追従するよう rebuild する。
            tr.getMeta(LINT_REBUILD_META) === true ||
            tr.getMeta(lintDecorationKey) != null;
          if (!forced && canMapGutterDecorations(tr)) {
            return oldDecos.map(tr.mapping, tr.doc);
          }
          return buildGutterDecorations(newState);
        } finally {
          markEnd("plugin.gutterMarks.apply");
        }
      },
    },
    props: {
      decorations(state) {
        return gutterMarksKey.getState(state);
      },
    },
  });
}
