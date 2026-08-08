// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { getEditorExtensions } from "@/features/editor/extensions";
import { transformAozoraNotationInSlice } from "@/features/editor/aozoraNotation";

describe("transformAozoraNotationInSlice", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = new Editor({ extensions: getEditorExtensions() });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("大量の壊れた開き括弧を線形時間でリテラルとして保持する", () => {
    const text = "《".repeat(30_000) + "》";
    const slice = new Slice(Fragment.from(editor.schema.text(text)), 0, 0);

    const startedAt = performance.now();
    const transformed = transformAozoraNotationInSlice(slice, editor.schema);
    const elapsedMs = performance.now() - startedAt;

    expect(transformed.content.firstChild?.text).toBe(text);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
