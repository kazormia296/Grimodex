// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "../extensions";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import {
  captureSwapSnapshot,
  isSwapSnapshotValid,
  paragraphFingerprint,
  revalidateParagraphContext,
} from "./paragraphSnapshot";

function makeEditor(content: string) {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content,
  });
}

describe("paragraphSnapshot", () => {
  it("paragraphFingerprint は内容変更で変わる", () => {
    const editor = makeEditor("<p>AAA。BBB。</p>");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const fp = paragraphFingerprint(resolved);
    editor.commands.insertContent("X");
    const after = resolveParagraphAtSelection(editor.state)!;
    expect(paragraphFingerprint(after)).not.toBe(fp);
    editor.destroy();
  });

  it("revalidateParagraphContext は一致時のみ fresh を返す", () => {
    const editor = makeEditor("<p>AAA。BBB。</p>");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    expect(revalidateParagraphContext(editor.state, resolved)).not.toBeNull();
    editor.commands.insertContent("Z");
    expect(revalidateParagraphContext(editor.state, resolved)).toBeNull();
    editor.destroy();
  });

  it("isSwapSnapshotValid は選択変更で false", () => {
    const editor = makeEditor("<p>A。B。</p>");
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const snap = captureSwapSnapshot(editor.state, resolved, 1);
    expect(isSwapSnapshotValid(editor.state, snap)).toBe(true);
    editor.commands.setTextSelection(4);
    expect(isSwapSnapshotValid(editor.state, snap)).toBe(false);
    editor.destroy();
  });
});
