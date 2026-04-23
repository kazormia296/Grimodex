// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { LintDisableMark } from "./LintDisableMark";

/**
 * Empirical check of what happens to a `lintDisable` Mark when a
 * replacement (Fix) clobbers its range. The design doc says the
 * Linter panel needs to notify "disable が削除されました" in that
 * case — knowing TipTap's behaviour here decides whether our
 * notification trigger is `before/after directive diff` (Mark GC'd)
 * or needs a zero-width Mark sweeper (Mark survives as empty).
 */
function createEditor() {
  return new Editor({
    extensions: [StarterKit, LintDisableMark],
    content: "",
  });
}

function markCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    for (const m of node.marks) {
      if (m.type.name === "lintDisable") count += 1;
    }
  });
  return count;
}

describe("LintDisableMark", () => {
  it("Fix that fully replaces the marked range drops the mark entirely", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent("hello world")
      .setTextSelection({ from: 7, to: 12 }) // "world"
      .setMark("lintDisable", { rules: ["*"] })
      .run();

    expect(markCount(editor)).toBe(1);

    // Apply a "fix": replace positions 7..12 with "MARS"
    editor.chain().focus().insertContentAt({ from: 7, to: 12 }, "MARS").run();

    // No zero-width residual — the mark is gone, doc reads "hello MARS".
    expect(markCount(editor)).toBe(0);
    expect(editor.getText()).toBe("hello MARS");
  });

  it("Partial overlap of a fix with a marked range leaves the mark intact on the surviving part", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent("abcdef")
      .setTextSelection({ from: 2, to: 6 }) // "bcde"
      .setMark("lintDisable", { rules: ["ja/foo"] })
      .run();

    expect(markCount(editor)).toBe(1);

    // Replace the first 2 chars of the mark ("bc" at 2..4) — the
    // remainder ("de") should still carry the mark.
    editor.chain().focus().insertContentAt({ from: 2, to: 4 }, "XY").run();

    expect(editor.getText()).toBe("aXYdef");
    expect(markCount(editor)).toBe(1);
  });
});
