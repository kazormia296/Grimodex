// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { buildReorderUnits } from "./reorderUnits";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { splitSentences } from "./sentenceSplit";

describe("reorderUnits EN", () => {
  const text = "She stood at the gate. He waved from afar.";

  it("splitSentences uses EN rules for en language", () => {
    expect(splitSentences(text, "en").length).toBeGreaterThanOrEqual(2);
  });

  it("splitSentences with ja language does not split on ASCII period", () => {
    expect(splitSentences(text, "ja").length).toBe(1);
  });

  it("buildReorderUnits sentence + en yields multiple units", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: `<p>${text}</p>`,
    });
    editor.commands.setTextSelection(1);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = buildReorderUnits(editor.state, resolved, "sentence", "en");
    editor.destroy();
    expect(units).not.toBeNull();
    expect(units!.length).toBeGreaterThanOrEqual(2);
  });

  it("buildReorderUnits sentence + ja on English prose yields single unit (no reorder)", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: `<p>${text}</p>`,
    });
    editor.commands.setTextSelection(1);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = buildReorderUnits(editor.state, resolved, "sentence", "ja");
    editor.destroy();
    expect(units).toBeNull();
  });
});
