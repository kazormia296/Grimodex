import type { AuthorshipSource } from "./AuthorshipMark";

/**
 * Minimal ProseMirror-JSON node shape we need to walk. We intentionally keep
 * this loose (rather than importing PM's Node) because we operate on the
 * serialized `map_stickies.body` string, not a live editor document.
 */
export interface PMMarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNodeJSON {
  type?: string;
  text?: string;
  marks?: PMMarkJSON[];
  content?: PMNodeJSON[];
}

export interface SeedAuthorshipAttrs {
  source: AuthorshipSource;
  timestamp?: string | null;
  model?: string | null;
}

/**
 * Add an `authorship` mark to every text node in a ProseMirror-JSON document.
 *
 * Idempotent: a text node that already carries an `authorship` mark is left
 * untouched, so re-running this (or running it on a doc that has been edited)
 * never re-stamps human-edited spans back to the seeded source. The guard
 * inspects the actual JSON mark `type` ("authorship"), not the rendered HTML
 * (`data-authorship`), so it works on stored bodies — which are JSON.
 *
 * Used at AI Branch sticky creation so the body is self-describing: human
 * edits later strip the mark via AiEditedPlugin, leaving per-span provenance
 * that copy serialization (span[data-authorship]) carries faithfully.
 */
export function addAuthorshipMarks(
  doc: PMNodeJSON,
  attrs: SeedAuthorshipAttrs,
): PMNodeJSON {
  const mark: PMMarkJSON = {
    type: "authorship",
    attrs: {
      source: attrs.source,
      timestamp: attrs.timestamp ?? null,
      model: attrs.model ?? null,
    },
  };

  function walk(node: PMNodeJSON): PMNodeJSON {
    if (node.type === "text" && typeof node.text === "string") {
      const existing = node.marks ?? [];
      if (existing.some((m) => m.type === "authorship")) return node;
      return { ...node, marks: [...existing, mark] };
    }
    if (node.content) {
      return { ...node, content: node.content.map(walk) };
    }
    return node;
  }

  return walk(doc);
}

/**
 * String-in / string-out wrapper around {@link addAuthorshipMarks} for callers
 * that hold a serialized body (e.g. `map_stickies.body`). Invalid JSON is
 * returned unchanged so a malformed body never throws during sticky creation.
 */
export function seedAuthorshipMarksJson(
  bodyJson: string,
  attrs: SeedAuthorshipAttrs,
): string {
  let doc: PMNodeJSON;
  try {
    doc = JSON.parse(bodyJson) as PMNodeJSON;
  } catch {
    return bodyJson;
  }
  return JSON.stringify(addAuthorshipMarks(doc, attrs));
}
