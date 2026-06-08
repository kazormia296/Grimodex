import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * Single source of truth for the "flat text ↔ ProseMirror position" contract
 * used by Codex matching.
 *
 * The codex matcher operates on a flattened plain-text view of the doc. That
 * flattening MUST be identical everywhere it is produced, or offsets returned by
 * the matcher map to the wrong ProseMirror positions and edits land in the wrong
 * place (silent corruption). The rules:
 *  - text node      → its characters (one flat slot each)
 *  - ruby atom      → its `base` characters (every base char maps to the SAME
 *                     PM pos, since the atom has nodeSize 1)
 *  - block boundary → a single "\n" slot between blocks (not before the first)
 *  - everything else (mention atoms, images, hr, …) → contributes NOTHING
 *
 * That last rule is load-bearing: mention atoms never enter the flat text, so the
 * matcher can never match inside a mention and a text rewrite can never corrupt
 * one (mentions are owned by the live NodeView, not by rename propagation).
 *
 * `text` here is byte-for-byte equal to `getDocText` (RubyNode.ts) — there is a
 * parity test guarding that. `flatPmPos[i]` is the PM position of flat offset i;
 * `flatIsRuby[i]` marks offsets that belong to a ruby atom (not rewritable as
 * plain text). The "\n" block-boundary slot points at the block's open position
 * and is never inside a match (char-class boundary checks reject "\n").
 */
export interface FlattenedDoc {
  text: string;
  flatPmPos: number[];
  flatIsRuby: boolean[];
}

export function flattenDocForCodex(doc: ProseMirrorNode): FlattenedDoc {
  let text = "";
  const flatPmPos: number[] = [];
  const flatIsRuby: boolean[] = [];
  let firstBlock = true;

  doc.descendants((node, pos) => {
    if (node.type.name === "ruby") {
      const base = (node.attrs.base as string) ?? "";
      for (let i = 0; i < base.length; i++) {
        flatPmPos.push(pos);
        flatIsRuby.push(true);
      }
      text += base;
      return false;
    }
    if (node.isText) {
      const t = node.text ?? "";
      for (let i = 0; i < t.length; i++) {
        flatPmPos.push(pos + i);
        flatIsRuby.push(false);
      }
      text += t;
      return;
    }
    if (node.isBlock) {
      if (!firstBlock) {
        flatPmPos.push(pos);
        flatIsRuby.push(false);
        text += "\n";
      }
      firstBlock = false;
    }
  });

  return { text, flatPmPos, flatIsRuby };
}
