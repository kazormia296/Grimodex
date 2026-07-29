import { beforeEach, describe, expect, it } from "vitest";
import {
  createEditorInstanceId,
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useExternalWriteStore } from "./externalWriteStore";
import { notifySameRendererDocumentWrite } from "./documentWriteNotification";

const base: DocumentKey = {
  kind: "codex",
  id: "entry-1",
  phaseId: null,
};
const phase: DocumentKey = {
  kind: "codex",
  id: "entry-1",
  phaseId: "phase-1",
};

describe("notifySameRendererDocumentWrite", () => {
  beforeEach(() => {
    useEditorSessionStore.getState().resetForProject();
    useExternalWriteStore.getState().clear();
  });

  it("reloads the exact clean document", () => {
    expect(
      notifySameRendererDocumentWrite(
        base,
        { domain: "codex", opType: "entry.update" },
        { inlineAiPending: false },
      ),
    ).toBe("reload");

    expect(
      useExternalWriteStore.getState().reloadNonce[encodeDocumentKey(base)],
    ).toBe(1);
    expect(
      useExternalWriteStore.getState().reloadNonce[encodeDocumentKey(phase)],
    ).toBeUndefined();
  });

  it("preserves an exact dirty buffer and records a conflict", () => {
    useEditorSessionStore
      .getState()
      .setDocumentDirty(base, true, createEditorInstanceId("test"));

    expect(
      notifySameRendererDocumentWrite(
        base,
        { domain: "codex", opType: "entry.update" },
        { inlineAiPending: false },
      ),
    ).toBe("conflict");

    expect(useExternalWriteStore.getState().conflicts).toEqual([
      expect.objectContaining({ documentKey: base, sceneId: "entry-1" }),
    ]);
    expect(
      useExternalWriteStore.getState().reloadNonce[encodeDocumentKey(base)],
    ).toBeUndefined();
  });

  it("does not treat a dirty Phase as a dirty base document", () => {
    useEditorSessionStore
      .getState()
      .setDocumentDirty(phase, true, createEditorInstanceId("phase"));

    expect(
      notifySameRendererDocumentWrite(
        base,
        { domain: "codex", opType: "entry.update" },
        { inlineAiPending: false },
      ),
    ).toBe("reload");
  });
});
