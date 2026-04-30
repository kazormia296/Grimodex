import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * Transaction meta key set by Beat generation code (initial insert / streaming
 * chunk / Regenerate). When present, appendTransaction below treats the change
 * as AI-authored and does NOT flip `modified` to true. Any other change inside
 * a generatedProseBlock is treated as user editing.
 */
export const BEAT_STREAM_META = "beatStreamOp" as const;

/**
 * GeneratedProseBlockNode — Beat の生成 prose を包むブロック。
 * `content: 'block+'` + `defining: true` により、外側からの段落結合に対して
 * 境界が保護される（境界跨ぎ削除で結合されない）。
 *
 * `modified` 属性は「生成後にユーザーが手で編集したか」を示す。
 * `appendTransaction` で `block` 内の変更を検出して true に倒す。
 */
export const GeneratedProseBlockNode = Node.create({
  name: "generatedProseBlock",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      beatId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-beat-id"),
        renderHTML: (attrs) =>
          attrs.beatId ? { "data-beat-id": attrs.beatId } : {},
      },
      modified: {
        default: false,
        parseHTML: (element) =>
          element.getAttribute("data-modified") === "true",
        renderHTML: (attrs) =>
          attrs.modified ? { "data-modified": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="generated-prose-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        {
          "data-type": "generated-prose-block",
          class: "generated-prose-block",
        },
        HTMLAttributes,
      ),
      0,
    ];
  },

  /**
   * ユーザーがブロック内で編集した瞬間に modified=true へ倒す。
   * Beat 生成コードが発行する transaction は `BEAT_STREAM_META` を立てて
   * 区別する（初期挿入・ストリーミングチャンク・Regenerate すべてこの経路）。
   * meta が立っている transaction では modified を変えない。
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const blocks: Array<{ pos: number; modified: boolean }> = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === "generatedProseBlock") {
              blocks.push({ pos, modified: !!node.attrs.modified });
            }
          });
          if (blocks.length === 0) return null;

          // Streaming / regenerate paths tag every transaction with
          // BEAT_STREAM_META. If the whole batch is tagged, it's AI-only.
          const aiOnlyChange = transactions.every(
            (tr) => tr.getMeta(BEAT_STREAM_META) === true,
          );

          // Find blocks whose content was touched by this transaction.
          const touched = new Set<number>();
          for (const { pos, modified } of blocks) {
            if (modified) continue;
            const node = newState.doc.nodeAt(pos);
            if (!node) continue;
            const oldNode = oldState.doc.nodeAt(pos);
            if (oldNode && oldNode.eq(node)) continue;
            touched.add(pos);
          }
          if (touched.size === 0) return null;
          if (aiOnlyChange) return null;

          const tr = newState.tr;
          for (const pos of touched) {
            const node = newState.doc.nodeAt(pos);
            if (!node) continue;
            tr.setNodeAttribute(pos, "modified", true);
          }
          return tr.steps.length > 0 ? tr : null;
        },
      }),
    ];
  },
});
