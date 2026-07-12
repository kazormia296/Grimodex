import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerEditorDocumentOpener,
  requestOpenEditorDocument,
} from "./editorNavigationRegistry";

const command = {
  target: { kind: "scene" as const, documentId: "scene-redo" },
  mode: "pinned" as const,
  revealEditor: true,
  focusEditor: false,
  syncSceneContext: false,
};

describe("editorNavigationRegistry", () => {
  afterEach(() => registerEditorDocumentOpener(null));

  it("dispatches an application navigation request to the installed adapter", () => {
    const opener = vi.fn();
    registerEditorDocumentOpener(opener);

    const dispatched = requestOpenEditorDocument(command);

    expect(dispatched).toBe(true);
    expect(opener).toHaveBeenCalledWith(command);
  });

  it("keeps headless history replay independent from renderer navigation", () => {
    expect(requestOpenEditorDocument(command)).toBe(false);
  });
});
