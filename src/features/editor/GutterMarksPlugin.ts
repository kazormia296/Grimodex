import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { ANNOTATION_REBUILD_META } from "@/features/post-effect/AnnotationPlugin";
import i18next from "@/lib/i18n";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { COMMENT_REBUILD_META } from "./CommentDecorationPlugin";

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

export type GutterChannel = "comment" | "foreshadow" | "review";

/** チャネル → 表示順。widget key にも同順で刻む。 */
const CHANNEL_ORDER: GutterChannel[] = ["comment", "foreshadow", "review"];

/** 9x9 の Lucide 相当アイコン (stroke=currentColor)。 */
const CHANNEL_ICON_PATHS: Record<GutterChannel, string> = {
  comment:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
  foreshadow:
    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" x2="4" y1="22" y2="15"></line>',
  review: '<path d="m6 16 6-12 6 12"></path><path d="M8 12h8"></path>',
};

const CHANNEL_LABEL_KEYS: Record<GutterChannel, string> = {
  comment: "editor.gutter.comment",
  foreshadow: "editor.gutter.foreshadow",
  review: "editor.gutter.review",
};

/** ブロック内に存在する（かつレイヤーONの）チャネルを収集する。 */
function collectChannels(node: ProseMirrorNode): GutterChannel[] {
  const cursor = useCursorSettingsStore.getState();
  const showReview = useAnnotationStore.getState().showAnnotations;

  let hasComment = false;
  let hasForeshadow = false;
  let hasReview = false;

  node.descendants((child) => {
    if (hasComment && hasForeshadow && hasReview) return false; // early exit
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
          if (m.attrs.status !== "dismissed") hasReview = true;
          break;
      }
    }
    return true;
  });

  const channels: GutterChannel[] = [];
  if (hasComment && cursor.showComments) channels.push("comment");
  if (hasForeshadow && cursor.showForeshadowMarks) channels.push("foreshadow");
  if (hasReview && showReview) channels.push("review");
  return channels;
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
  state.doc.descendants((node, pos) => {
    // 最内の textblock (paragraph/heading 等) にのみ描く。blockquote/listItem/
    // tableCell などのコンテナ側にも描くと内側の段落と二重になる
    // (offsetMap の「nested block を持つブロックは自前テキストを出さない」
    // passthrough ガードと同じ理由)。sceneBeat は本文ではないので対象外。
    if (!node.isTextblock || node.type.name === "sceneBeat") return true;

    const channels = collectChannels(node);
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

export function createGutterMarksPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: gutterMarksKey,
    state: {
      init(_config, state) {
        return buildGutterDecorations(state);
      },
      apply(tr, oldDecos, _oldState, newState) {
        const forced =
          tr.getMeta(GUTTER_REBUILD_META) === true ||
          tr.getMeta(COMMENT_REBUILD_META) === true ||
          tr.getMeta(ANNOTATION_REBUILD_META) === true;
        if (!forced && !tr.docChanged) {
          return oldDecos.map(tr.mapping, tr.doc);
        }
        return buildGutterDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return gutterMarksKey.getState(state);
      },
    },
  });
}
