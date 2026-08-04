import { describe, expect, it } from "vitest";
import { createEditorStickyMaskId } from "./editorStickyMaskId";

describe("editor sticky mask ids", () => {
  it("keeps the same sticky unique when rendered by two surfaces", () => {
    const primary = createEditorStickyMaskId("sticky-1", ":r0:");
    const secondary = createEditorStickyMaskId("sticky-1", ":r1:");

    expect(primary).not.toBe(secondary);
    expect(primary).toBe("editor-sticky-mask-sticky-1--r0-");
    expect(secondary).toBe("editor-sticky-mask-sticky-1--r1-");
  });
});
