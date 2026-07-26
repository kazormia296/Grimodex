// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "../extensions";
import { splitSentencesJa } from "./sentenceSplit";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import {
  buildAdjacentUnitSwapTransaction,
  buildParagraphReorderTransaction,
  findUnitIndexAtFlatOffset,
} from "./reorderTransaction";

function makeEditor(content: string) {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content,
  });
}

describe("reorderTransaction", () => {
  it("隣接 2 文を swap する", () => {
    const editor = makeEditor("<p>AAA。BBB。</p>");
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    expect(units).toHaveLength(2);

    const unitIdx = findUnitIndexAtFlatOffset(units, 2);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    expect(result).not.toBeNull();
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe("BBB。AAA。");
    editor.destroy();
  });

  it("3 unit permutation で順序を入れ替える", () => {
    const editor = makeEditor("<p>A。B。C。</p>");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    const result = buildParagraphReorderTransaction(
      editor.state,
      resolved,
      units,
      [2, 0, 1],
    );
    expect(result).not.toBeNull();
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe("C。A。B。");
    editor.destroy();
  });

  it("端 unit への swap は null", () => {
    const editor = makeEditor("<p>A。B。</p>");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    expect(
      buildAdjacentUnitSwapTransaction(editor.state, resolved, units, 0, -1),
    ).toBeNull();
    editor.destroy();
  });

  it("swap 後も authorship mark を保持する", () => {
    const editor = makeEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "AAA。",
              marks: [{ type: "authorship", attrs: { source: "ai" } }],
            },
            {
              type: "text",
              text: "BBB。",
              marks: [{ type: "authorship", attrs: { source: "human" } }],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    const unitIdx = findUnitIndexAtFlatOffset(units, 2);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    editor.view.dispatch(result!.tr);

    let aiFound = false;
    let humanFound = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (!mark) return;
      if (node.text?.includes("AAA")) aiFound = mark.attrs.source === "ai";
      if (node.text?.includes("BBB"))
        humanFound = mark.attrs.source === "human";
    });
    expect(aiFound).toBe(true);
    expect(humanFound).toBe(true);
    editor.destroy();
  });

  it("swap 後もキャレットは unit 内 offset を保つ", () => {
    const editor = makeEditor("<p>AAA。BBB。</p>");
    editor.commands.setTextSelection(3);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    const unitIdx = findUnitIndexAtFlatOffset(units, 3);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    editor.view.dispatch(result!.tr);
    expect(editor.state.selection.$from.parent.textContent).toContain("AAA");
    editor.destroy();
  });

  it("unit 間の mention を swap 後も保持する", () => {
    const editor = makeEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "AAA。" },
            { type: "mention", attrs: { id: "1", label: "ナナ" } },
            { type: "text", text: "BBB。" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    const unitIdx = findUnitIndexAtFlatOffset(units, 2);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    expect(result).not.toBeNull();
    editor.view.dispatch(result!.tr);

    let mentionCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionCount++;
    });
    expect(mentionCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("BBB。AAA。");
    editor.destroy();
  });

  it("unit 間（文境界）の hardBreak を swap 後も保持する", () => {
    const editor = makeEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "AAA。" },
            { type: "hardBreak" },
            { type: "text", text: "BBB。" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    expect(units).toHaveLength(2);
    const unitIdx = findUnitIndexAtFlatOffset(units, 2);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    expect(result).not.toBeNull();
    editor.view.dispatch(result!.tr);

    let hardBreakCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "hardBreak") hardBreakCount++;
    });
    expect(hardBreakCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("BBB。AAA。");
    editor.destroy();
  });

  it("長さの異なる unit 間の mention を swap 後も保持する（データ欠損回帰）", () => {
    // 旧実装は新順序の累積 offset と flatAnchor を === 比較していたため、
    // 入れ替える 2 unit の長さが異なると境界 inline が消失していた。
    // "ABC。"(4) と "DE。"(3) は長さが違うので、その回帰を突く。
    const editor = makeEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "ABC。" },
            { type: "mention", attrs: { id: "1", label: "ナナ" } },
            { type: "text", text: "DE。" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    expect(units).toHaveLength(2);
    const unitIdx = findUnitIndexAtFlatOffset(units, 2);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    expect(result).not.toBeNull();
    editor.view.dispatch(result!.tr);

    let mentionCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionCount++;
    });
    expect(mentionCount).toBe(1); // 消えていないこと
    expect(editor.state.doc.textContent).toBe("DE。ABC。");
    editor.destroy();
  });

  it("unit 内の hardBreak を swap 後も保持する", () => {
    const editor = makeEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            { type: "hardBreak" },
            { type: "text", text: "B。" },
            { type: "text", text: "C。" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentencesJa(resolved.flat.text);
    expect(units).toHaveLength(2);
    const unitIdx = findUnitIndexAtFlatOffset(units, 2);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
    );
    editor.view.dispatch(result!.tr);

    let hardBreakCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "hardBreak") hardBreakCount++;
    });
    expect(hardBreakCount).toBe(1);
    editor.destroy();
  });
});
