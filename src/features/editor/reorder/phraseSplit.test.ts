// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { splitWordsEn } from "./wordSplit";
import { tagEnglishTokens } from "./phrasePosTag";
import { splitPhrasesEn, needsEnglishPhraseGap } from "./phraseSplit";
import { buildAdjacentUnitSwapTransaction } from "./reorderTransaction";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { resolveSelectionUnits } from "./selectionUnit";

function surfaces(text: string): string[] {
  return splitPhrasesEn(text).map((u) => u.surface);
}

function tags(text: string): string[] {
  return tagEnglishTokens(splitWordsEn(text)).map((t) => t.tag);
}

describe("phrasePosTag", () => {
  it("代表語に粗 POS を付与する", () => {
    expect(tags("She stood at the gate.")).toEqual([
      "PRP",
      "VBD",
      "IN",
      "DT",
      "NN",
    ]);
    expect(tags("The old man waited.")).toEqual(["DT", "JJ", "NN", "VBD"]);
    // "New" は常用形容詞辞書に載るため JJ。chunk では JJ+NNP が NP にまとまる。
    expect(tags("I went to New York.")).toEqual([
      "PRP",
      "VBD",
      "IN",
      "JJ",
      "NNP",
    ]);
  });

  it("文中の大文字動詞を NNP に誤判定しない（辞書優先）", () => {
    expect(tags("He ran. Stood guard.")).toEqual(["PRP", "VBD", "VBD", "NN"]);
  });
});

describe("phraseSplit", () => {
  it("代表文を shallow phrase に分割する", () => {
    expect(surfaces("She stood at the gate.")).toEqual([
      "She",
      "stood",
      "at the gate.",
    ]);
    expect(surfaces("He waved from afar.")).toEqual([
      "He",
      "waved",
      "from afar.",
    ]);
    expect(surfaces("The old man waited.")).toEqual(["The old man", "waited."]);
    expect(surfaces("I went to New York.")).toEqual([
      "I",
      "went",
      "to New York.",
    ]);
  });

  it("文中の大文字動詞が後続名詞に誤結合しない", () => {
    // "Stood" が VBD として VP になり、"guard." と別 unit になること。
    expect(surfaces("He ran. Stood guard.")).toEqual([
      "He",
      "ran.",
      "Stood",
      "guard.",
    ]);
  });

  it("CoNLL 型の文でも連続被覆する", () => {
    expect(
      surfaces("He reckons the current account deficit will narrow."),
    ).toEqual(["He", "reckons", "the current account deficit", "will narrow."]);
  });

  it("needsEnglishPhraseGap は phrase 間に空白を要求する", () => {
    const units = splitPhrasesEn("She stood");
    expect(needsEnglishPhraseGap(units[0]!, units[1]!)).toBe(true);
  });

  it("phrase swap 後も語間空白を保持する", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>She stood at the gate.</p>",
    });
    editor.commands.setTextSelection(5);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitPhrasesEn(resolved.flat.text);
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
      "phrase",
    );
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe("She at the gate. stood");
    editor.destroy();
  });

  it("語終端キャレットで stood を選んで swap できる", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>She stood at the gate.</p>",
    });
    editor.commands.setTextSelection(10);
    const ctx = resolveSelectionUnits(editor.state, "phrase", "en");
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
      "phrase",
    );
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe("She at the gate. stood");
    editor.destroy();
  });
});
