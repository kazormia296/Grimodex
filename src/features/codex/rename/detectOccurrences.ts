import {
  createCodexMatcher,
  parseAliases,
  type CodexMatchTarget,
} from "../codexMatcher";

/**
 * Detection layer for Codex rename propagation (Item C).
 *
 * Finds every plain-text occurrence of an entry's OLD name across scene bodies
 * and other entries' free-text fields, so the user can review and rewrite them
 * to the new name. Pure / synchronous: it runs the JS `createCodexMatcher`
 * against pre-flattened text, so it is fully unit-testable and never touches the
 * global Rust matcher (which holds CURRENT names and would be corrupted by a
 * temporary old-name rebuild).
 *
 * Duplicate-safety is inherited from the matcher, not re-implemented:
 *  - substring of a longer name (「太郎」⊂「山田太郎」) → longest-match gives the
 *    span to the longer entry, so its `hit` ≠ oldName and it is excluded here.
 *  - same name / alias shared by another current entry → `ambiguous` is set and
 *    the UI defaults those rows OFF (attribution genuinely can't be decided).
 */

/** A `kind` discriminator the apply layer uses to route the write-back. */
export type RenameSourceKind =
  | "scene-body" // tree_nodes.content (ProseMirror JSON)
  | "node-title" // tree_nodes.title (plain)
  | "node-synopsis" // tree_nodes.synopsis (plain)
  | "codex-summary" // codex_entries.summary (plain)
  | "codex-content" // codex_entries.content (ProseMirror JSON)
  | "codex-notes" // codex_entries.notes (ProseMirror JSON)
  | "codex-detail" // codex_detail_values.value (plain, fieldType=text)
  | "codex-relation-label"; // codex_relations.label (plain)

/** Kinds whose underlying storage is a ProseMirror JSON document (need flattening). */
export const PM_DOC_KINDS: ReadonlySet<RenameSourceKind> = new Set([
  "scene-body",
  "codex-content",
  "codex-notes",
]);

export interface RenameSourceText {
  kind: RenameSourceKind;
  /** Primary id the apply layer writes to (sceneId / entryId / relationId). */
  refId: string;
  /** Human-facing label for the preview (scene title / entry name / field name). */
  refLabel: string;
  /** For `codex-detail`: the detail definition id whose value holds the text. */
  detailDefinitionId?: string;
  /**
   * Plain text to scan. For ProseMirror docs this is the `getDocText`-equivalent
   * flattened text (see `flattenDocForCodex`); for plain DB columns it is the
   * raw value.
   */
  text: string;
  /**
   * Per-offset ruby flag, same length as `text`. Only set for flattened PM docs.
   * A match overlapping a ruby atom cannot be rewritten as a plain text edit, so
   * it is surfaced as `ruby: true` and excluded from apply.
   */
  isRubyByOffset?: boolean[];
  /**
   * For PM-doc kinds: the original ProseMirror JSON string. The apply layer
   * reconstructs the doc from this and applies the flat-offset spans to it
   * (the doc is quiescent between detect and apply because the preview is modal).
   * Undefined for plain-text kinds (`text` itself is the stored value).
   */
  rawContent?: string;
}

export interface RenameOccurrence {
  source: RenameSourceText;
  /** Flat offsets into `source.text`. */
  from: number;
  to: number;
  /** Context for the preview row. */
  before: string;
  hit: string;
  after: string;
  /** Overlaps a ruby atom → not safely rewritable (excluded from apply). */
  ruby: boolean;
}

export interface DetectRenameResult {
  occurrences: RenameOccurrence[];
  /**
   * Another CURRENT entry shares the old name (as name or alias). When true the
   * old-name spans can't be attributed to this entry with confidence, so the UI
   * should default every row OFF and warn.
   */
  ambiguous: boolean;
}

function rubyOverlap(
  isRubyByOffset: boolean[] | undefined,
  from: number,
  to: number,
): boolean {
  if (!isRubyByOffset) return false;
  for (let i = from; i < to; i++) {
    if (isRubyByOffset[i]) return true;
  }
  return false;
}

function excerpt(
  text: string,
  from: number,
  to: number,
  ctx: number,
): { before: string; hit: string; after: string } {
  const beforeStart = Math.max(0, from - ctx);
  const afterEnd = Math.min(text.length, to + ctx);
  return {
    before: (beforeStart > 0 ? "…" : "") + text.slice(beforeStart, from),
    hit: text.slice(from, to),
    after: text.slice(to, afterEnd) + (afterEnd < text.length ? "…" : ""),
  };
}

export interface DetectRenameParams {
  entryId: string;
  oldName: string;
  newName: string;
  /** Current entries (with CURRENT names) — drives longest-match/exclusion. */
  allTargets: CodexMatchTarget[];
  sources: RenameSourceText[];
  /** Context chars on each side of the hit for the preview snippet. */
  contextLen?: number;
}

export function detectRenameOccurrences(
  params: DetectRenameParams,
): DetectRenameResult {
  const {
    entryId,
    oldName,
    newName,
    allTargets,
    sources,
    contextLen = 24,
  } = params;

  const empty: DetectRenameResult = { occurrences: [], ambiguous: false };
  if (!oldName || oldName === newName) return empty;

  // The renamed entry carries its OLD name so the matcher locates old-name
  // spans; every OTHER entry keeps its current name so longest-match and
  // excluded-alias resolution stay correct.
  const targets = allTargets.map((t) =>
    t.id === entryId ? { ...t, name: oldName } : t,
  );
  const matcher = createCodexMatcher(targets);
  const oldLower = oldName.toLowerCase();

  const occurrences: RenameOccurrence[] = [];
  for (const source of sources) {
    if (!source.text) continue;
    for (const m of matcher(source.text)) {
      const hit = source.text.slice(m.from, m.to);
      // Keep only spans that ARE the old name. A longer different entry name
      // covering this position yields a different `hit` and is correctly skipped.
      if (hit.toLowerCase() !== oldLower) continue;
      const { before, after } = excerpt(source.text, m.from, m.to, contextLen);
      occurrences.push({
        source,
        from: m.from,
        to: m.to,
        before,
        hit,
        after,
        ruby: rubyOverlap(source.isRubyByOffset, m.from, m.to),
      });
    }
  }

  const ambiguous = allTargets.some(
    (t) =>
      t.id !== entryId &&
      (t.name === oldName || parseAliases(t.aliases).includes(oldName)),
  );

  return { occurrences, ambiguous };
}
