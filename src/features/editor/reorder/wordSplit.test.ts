// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { splitWordsEn, needsEnglishWordGap } from "./wordSplit";
import {
  buildAdjacentUnitSwapTransaction,
  findUnitIndexAtFlatOffset,
} from "./reorderTransaction";
import {
  pmPosToFlatOffset,
  resolveParagraphAtSelection,
} from "./paragraphFlat";
import { resolveSelectionUnits } from "./selectionUnit";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

describe("wordSplit", () => {
  it("空白で語に分割する", () => {
    const text = "She stood at the gate.";
    const units = splitWordsEn(text);
    expect(units.map((u) => u.surface)).toEqual([
      "She",
      "stood",
      "at",
      "the",
      "gate.",
    ]);
  });

  it("needsEnglishWordGap は語間に空白を要求する", () => {
    const units = splitWordsEn("She stood");
    expect(needsEnglishWordGap(units[0]!, units[1]!)).toBe(true);
  });

  it("語終端直後の空白 offset は直前の word unit を選ぶ", () => {
    const units = splitWordsEn("She stood at");
    expect(units[1]!.surface).toBe("stood");
    expect(units[1]!.to).toBe(9);
    expect(findUnitIndexAtFlatOffset(units, 8)).toBe(1);
    expect(findUnitIndexAtFlatOffset(units, 9)).toBe(1);
    expect(findUnitIndexAtFlatOffset(units, 10)).toBe(2);
  });

  it("語終端キャレットで stood と at が入れ替わる", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>She stood at the gate.</p>",
    });
    // stood の直後（語間空白）= PM 10
    editor.commands.setTextSelection(10);
    const ctx = resolveSelectionUnits(editor.state, "word", "en");
    expect(ctx?.units[ctx.unitIndex]?.surface).toBe("stood");
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      ctx!.resolved,
      ctx!.units,
      ctx!.unitIndex,
      1,
      undefined,
      undefined,
      "en",
      "word",
    );
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe("She at stood the gate.");
    editor.destroy();
  });

  it("swap 後も語間空白を保持する", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>She stood at the gate.</p>",
    });
    editor.commands.setTextSelection(5);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitWordsEn(resolved.flat.text);
    const stoodIdx = units.findIndex((u) => u.surface === "stood");
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      stoodIdx,
      1,
      undefined,
      undefined,
      "en",
      "word",
    );
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe("She at stood the gate.");
    editor.destroy();
  });

  it("pmPosToFlatOffset が語間空白を返しても stood を選ぶ", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>She stood at</p>",
    });
    editor.commands.setTextSelection(10);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const flat = pmPosToFlatOffset(resolved.flat, editor.state.selection.from);
    const units = splitWordsEn(resolved.flat.text);
    expect(flat).toBe(9);
    expect(findUnitIndexAtFlatOffset(units, flat)).toBe(1);
    editor.destroy();
  });
});
