import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { flattenDocForCodex } from "@/features/editor/codexDocFlatten";

/** A span to rewrite, expressed as flat offsets into `flattenDocForCodex(doc).text`. */
export interface FlatSpan {
  from: number;
  to: number;
}

export interface ApplyResult {
  doc: ProseMirrorNode;
  /** Spans actually rewritten. */
  applied: number;
  /** Spans skipped (ruby overlap, or non-contiguous in PM space). */
  skipped: number;
}

/**
 * Rewrite the given old-name spans to `newName` inside a ProseMirror doc,
 * preserving the marks of the replaced text and never touching anything that
 * isn't a plain text run.
 *
 * Contract (shared with the matcher via {@link flattenDocForCodex}):
 *  - `from`/`to` are flat offsets into the doc's flattened text.
 *  - Replacements are applied back-to-front so earlier offsets stay valid as
 *    the doc length changes — `newName` may be longer/shorter than the old name.
 *  - Marks: the new text inherits the marks of the text node at `from`, so a
 *    bold/italic name stays bold/italic (existing authorship is preserved, not
 *    fabricated; see design §5.4).
 *  - Ruby atoms: a span overlapping a ruby base can't be expressed as a text
 *    edit (the base lives in an attr), so it is skipped and counted.
 *  - Mentions: structurally unreachable — mention atoms contribute no flat
 *    offsets, so no span can land inside one.
 *  - Non-contiguous spans (a match that crosses a block boundary, which
 *    shouldn't happen because "\n" fails boundary checks) are skipped defensively.
 */
export function applyReplacementsToDoc(
  doc: ProseMirrorNode,
  spans: FlatSpan[],
  newName: string,
): ApplyResult {
  if (spans.length === 0 || newName.length === 0) {
    return { doc, applied: 0, skipped: 0 };
  }

  const { flatPmPos, flatIsRuby } = flattenDocForCodex(doc);
  const schema = doc.type.schema;

  // Back-to-front: edits at higher positions never shift the lower ones, so the
  // pmPos values computed from the original doc stay valid for remaining spans.
  const ordered = [...spans].sort((a, b) => b.from - a.from);

  const tr = new Transform(doc);
  let applied = 0;
  let skipped = 0;

  for (const span of ordered) {
    const { from, to } = span;
    if (from < 0 || to > flatPmPos.length || from >= to) {
      skipped++;
      continue;
    }

    // Ruby overlap → not rewritable as text.
    let ruby = false;
    for (let i = from; i < to; i++) {
      if (flatIsRuby[i]) {
        ruby = true;
        break;
      }
    }
    if (ruby) {
      skipped++;
      continue;
    }

    const pmFrom = flatPmPos[from]!;
    const pmTo = flatPmPos[to - 1]! + 1;
    // The span must be contiguous in PM space (no node boundary mid-span).
    if (pmTo - pmFrom !== to - from) {
      skipped++;
      continue;
    }

    const marks = doc.nodeAt(pmFrom)?.marks ?? undefined;
    tr.replaceWith(pmFrom, pmTo, schema.text(newName, marks));
    applied++;
  }

  return { doc: tr.doc, applied, skipped };
}

/**
 * Plain-string variant for non-PM fields (codex summary / detail value text /
 * relation label). Same back-to-front discipline; no marks, no ruby.
 */
export function applyReplacementsToString(
  text: string,
  spans: FlatSpan[],
  newName: string,
): string {
  if (spans.length === 0) return text;
  const ordered = [...spans].sort((a, b) => b.from - a.from);
  let out = text;
  for (const { from, to } of ordered) {
    if (from < 0 || to > out.length || from >= to) continue;
    out = out.slice(0, from) + newName + out.slice(to);
  }
  return out;
}
