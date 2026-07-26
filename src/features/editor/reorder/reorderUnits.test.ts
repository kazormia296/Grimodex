// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { buildReorderUnits, splitCharacters } from "./reorderUnits";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import type { ReorderUnit } from "./types";

/** units が [0, length) を隙間・重複なく連続被覆することを確認する。 */
function assertFullCoverage(units: ReorderUnit[], length: number): void {
  expect(units.length).toBeGreaterThan(0);
  expect(units[0]!.from).toBe(0);
  expect(units[units.length - 1]!.to).toBe(length);
  for (let i = 1; i < units.length; i++) {
    expect(units[i]!.from).toBe(units[i - 1]!.to);
  }
}

function stateWithParagraph(
  html: string,
  selection?: { from: number; to: number },
) {
  const editor = new Editor({
    extensions: [StarterKit],
    content: html,
  });
  if (selection) {
    editor.commands.setTextSelection(selection);
  }
  const state = editor.state;
  editor.destroy();
  return state;
}

describe("reorderUnits", () => {
  it("splitCharacters produces one unit per code unit", () => {
    expect(splitCharacters("AB", 0, 2)).toEqual([
      { from: 0, to: 1, surface: "A" },
      { from: 1, to: 2, surface: "B" },
    ]);
  });

  it("character granularity uses full paragraph when no selection", () => {
    const state = stateWithParagraph("<p>AB</p>", { from: 1, to: 1 });
    const resolved = resolveParagraphAtSelection(state)!;
    const units = buildReorderUnits(state, resolved, "character", "ja");
    expect(units).toEqual([
      { from: 0, to: 1, surface: "A" },
      { from: 1, to: 2, surface: "B" },
    ]);
  });

  it("character + selection: range becomes one override unit, rest tiled as chars, full coverage", () => {
    // PM from=2,to=4 → flat [1,3)="BC"。前後は文字 unit で被覆する。
    const state = stateWithParagraph("<p>ABCD</p>", { from: 2, to: 4 });
    const resolved = resolveParagraphAtSelection(state)!;
    const units = buildReorderUnits(state, resolved, "character", "ja");
    expect(units).toEqual([
      { from: 0, to: 1, surface: "A" },
      { from: 1, to: 3, surface: "BC" },
      { from: 3, to: 4, surface: "D" },
    ]);
    assertFullCoverage(units!, resolved.flat.text.length);
  });

  it("bunsetsu + selection straddling boundaries covers every character (no drop)", () => {
    // 文節 [0,2)[2,4)[4,6)、選択 flat [3,5) は 2 つの文節を跨ぐ。
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>あいうえおか</p>",
    });
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const selFrom = resolved.flat.flatPmPos[3]!;
    const selTo = resolved.flat.flatPmPos[5]!;
    editor.commands.setTextSelection({ from: selFrom, to: selTo });
    const state = editor.state;
    const bunsetsu = [
      { from: 0, to: 2, surface: "あい" },
      { from: 2, to: 4, surface: "うえ" },
      { from: 4, to: 6, surface: "おか" },
    ];
    const units = buildReorderUnits(
      state,
      resolved,
      "bunsetsu",
      "ja",
      bunsetsu,
    );
    editor.destroy();
    expect(units).not.toBeNull();
    assertFullCoverage(units!, 6);
    // 選択区間そのものが 1 unit（override）として存在する。
    expect(units!.some((u) => u.from === 3 && u.to === 5)).toBe(true);
  });

  it("selection override merges selected span into one sentence unit", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>あいう。えお。かきく。</p>",
    });
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const selFrom = resolved.flat.flatPmPos[4]!;
    const selTo = resolved.flat.flatPmPos[8]!;
    editor.commands.setTextSelection({ from: selFrom, to: selTo });
    const state = editor.state;
    const units = buildReorderUnits(state, resolved, "sentence", "ja");
    editor.destroy();
    expect(units?.map((u) => u.surface)).toEqual([
      "あいう。",
      "えお。か",
      "きく。",
    ]);
  });
});
