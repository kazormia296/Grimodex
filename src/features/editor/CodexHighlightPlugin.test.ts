import { describe, it, expect } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "@tiptap/pm/schema-basic";
import { DecorationSet } from "@tiptap/pm/view";
import type { CodexMatch } from "@/features/codex/codexMatcher";
import {
  codexHighlightKey,
  createCodexHighlightPlugin,
} from "./CodexHighlightPlugin";

function makeState(text: string): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
    plugins: [createCodexHighlightPlugin()],
  });
}

function seedMatches(state: EditorState, matches: CodexMatch[]): EditorState {
  const tr = state.tr.setMeta("codexHighlightResult", matches);
  return state.apply(tr);
}

function getDecoSet(state: EditorState): DecorationSet {
  return codexHighlightKey.getState(state) as DecorationSet;
}

describe("CodexHighlightPlugin – adjacent decoration crash guard", () => {
  it("clears decorations when initial set already contains adjacent decos", () => {
    // "abcdef" → flat indices [0,3) and [3,6) produce PM decos [1,4) and [4,7)
    const state = makeState("abcdef");
    const seeded = seedMatches(state, [
      { from: 0, to: 3, entryId: "1", entryType: "person", entryName: "a" },
      { from: 3, to: 6, entryId: "2", entryType: "person", entryName: "b" },
    ]);
    expect(getDecoSet(seeded).find()).toHaveLength(2);

    // any docChanged tr triggers adjacency guard → empty
    const tr = seeded.tr.insertText("x", 7);
    const next = seeded.apply(tr);
    expect(getDecoSet(next)).toBe(DecorationSet.empty);
  });

  it("clears decorations when mapping pulls non-adjacent decos into adjacency", () => {
    // "abcde fghij": match1 [0,5) and match2 [6,11) are non-adjacent in PM
    // (PM [1,6) and [7,12), gap at PM pos 6 = space char)
    const state = makeState("abcde fghij");
    const seeded = seedMatches(state, [
      { from: 0, to: 5, entryId: "1", entryType: "person", entryName: "a" },
      { from: 6, to: 11, entryId: "2", entryType: "person", entryName: "b" },
    ]);
    const initial = getDecoSet(seeded).find();
    expect(initial).toHaveLength(2);
    expect(initial[0].to).toBeLessThan(initial[1].from); // non-adjacent

    // Delete the space at PM [6,7): shifts deco2 from [7,12) to [6,11),
    // making it adjacent to deco1 [1,6) after mapping.
    const tr = seeded.tr.delete(6, 7);
    const next = seeded.apply(tr);
    expect(getDecoSet(next)).toBe(DecorationSet.empty);
  });

  it("preserves non-adjacent decorations across docChanged trs", () => {
    const state = makeState("abcde fghij");
    const seeded = seedMatches(state, [
      { from: 0, to: 5, entryId: "1", entryType: "person", entryName: "a" },
      { from: 6, to: 11, entryId: "2", entryType: "person", entryName: "b" },
    ]);

    // Insert text at end → no adjacency introduced
    const tr = seeded.tr.insertText("!", 12);
    const next = seeded.apply(tr);
    const after = getDecoSet(next).find();
    expect(after).toHaveLength(2);
    expect(after[0].to).toBeLessThan(after[1].from);
  });
});
