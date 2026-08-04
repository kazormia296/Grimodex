// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { useEditorTextCoverage } from "./useEditorTextCoverage";

function createEditorFixture() {
  const root = document.createElement("div");
  root.textContent = "long editor text";
  document.body.append(root);
  const on = vi.fn();
  const off = vi.fn();
  return {
    root,
    editor: {
      view: { dom: root },
      on,
      off,
    } as unknown as Editor,
    on,
    off,
  };
}

describe("useEditorTextCoverage", () => {
  it("does not attach observers or read ranges when disabled", () => {
    const { root, editor, on } = createEditorFixture();
    const surface = document.createElement("div");
    document.body.append(surface);
    const createRange = vi.spyOn(document, "createRange");
    const surfaceRef = { current: surface };
    const draggingRef = { current: false };

    renderHook(() =>
      useEditorTextCoverage(editor, surfaceRef, draggingRef, false),
    );

    expect(on).not.toHaveBeenCalled();
    expect(createRange).not.toHaveBeenCalled();

    act(() => {
      surface.dispatchEvent(new Event("compositionstart"));
      root.dispatchEvent(new Event("input"));
    });
    expect(createRange).not.toHaveBeenCalled();
    createRange.mockRestore();
    root.remove();
    surface.remove();
  });
});
