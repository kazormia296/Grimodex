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

          // Match blocks by beatId (their stable identity) rather than by
          // doc position — upstream edits shift positions even when block
          // content is unchanged.
          type BlockEntry = {
            pos: number;
            content: import("@tiptap/pm/model").Fragment;
            modified: boolean;
            beatId: string | null;
          };
          const collect = (state: typeof newState): BlockEntry[] => {
            const out: BlockEntry[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === "generatedProseBlock") {
                out.push({
                  pos,
                  content: node.content,
                  modified: !!node.attrs.modified,
                  beatId: (node.attrs.beatId as string) ?? null,
                });
              }
            });
            return out;
          };
          const newBlocks = collect(newState);
          if (newBlocks.length === 0) return null;
          const oldByBeatId = new Map<string, BlockEntry>();
          for (const b of collect(oldState)) {
            if (b.beatId) oldByBeatId.set(b.beatId, b);
          }

          // Collect beat ids still in the doc — used to detect orphaned blocks
          // (block whose linked beat has been deleted, e.g. via "Delete beat
          // only" or Unplace). These must be unwrapped per spec.
          const beatIdsInDoc = new Set<string>();
          newState.doc.descendants((node) => {
            if (node.type.name === "sceneBeat" && node.attrs.id) {
              beatIdsInDoc.add(node.attrs.id as string);
            }
          });

          // Streaming / regenerate paths tag every transaction with
          // BEAT_STREAM_META. If the whole batch is tagged, it's AI-only.
          const aiOnlyChange = transactions.every(
            (tr) => tr.getMeta(BEAT_STREAM_META) === true,
          );

          // Pass 1: identify orphan blocks to unwrap. Only unwrap blocks that
          // existed in oldState too — never unwrap a freshly-inserted block
          // before its beat is hooked up.
          const orphans: BlockEntry[] = [];
          for (const block of newBlocks) {
            if (!block.beatId) continue;
            if (beatIdsInDoc.has(block.beatId)) continue;
            if (!oldByBeatId.has(block.beatId)) continue;
            orphans.push(block);
          }

          // Pass 2: identify blocks whose content actually changed (→ flip
          // modified=true). Skip blocks slated for unwrap.
          const orphanPositions = new Set(orphans.map((o) => o.pos));
          const touched = new Set<number>();
          for (const block of newBlocks) {
            if (block.modified) continue;
            if (orphanPositions.has(block.pos)) continue;
            const prior = block.beatId
              ? oldByBeatId.get(block.beatId)
              : undefined;
            // Same beatId + same content → block didn't really change
            // (likely just shifted by an upstream edit).
            if (prior && prior.content.eq(block.content)) continue;
            touched.add(block.pos);
          }

          const willFlip = !aiOnlyChange && touched.size > 0;
          if (orphans.length === 0 && !willFlip) return null;

          const tr = newState.tr;

          // Unwrap orphans bottom-up so earlier orphan positions stay valid
          // for each other. After these steps, `touched` positions captured
          // pre-tr need to be remapped through tr.mapping — they may have
          // shifted if a touched block sits after an unwrapped orphan.
          for (const orphan of [...orphans].sort((a, b) => b.pos - a.pos)) {
            const node = newState.doc.nodeAt(orphan.pos);
            if (!node) continue;
            tr.replaceWith(
              orphan.pos,
              orphan.pos + node.nodeSize,
              node.content,
            );
          }

          if (willFlip) {
            for (const pos of touched) {
              const mapped = tr.mapping.map(pos);
              const node = tr.doc.nodeAt(mapped);
              if (!node || node.type.name !== "generatedProseBlock") continue;
              tr.setNodeAttribute(mapped, "modified", true);
            }
          }

          return tr.steps.length > 0 ? tr : null;
        },
      }),
    ];
  },
});
