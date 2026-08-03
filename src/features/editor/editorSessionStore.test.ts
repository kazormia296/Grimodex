import { beforeEach, describe, expect, it } from "vitest";
import {
  createEditorInstanceId,
  type DocumentKey,
} from "./document/documentKey";
import { useEditorSessionStore } from "./editorSessionStore";

describe("editorSessionStore dirty instances", () => {
  beforeEach(() => {
    useEditorSessionStore.getState().resetForProject();
  });

  it("keeps a document dirty while any mounted instance is dirty", () => {
    const key: DocumentKey = {
      kind: "codex",
      id: "entry-1",
      phaseId: "phase-1",
    };
    const first = createEditorInstanceId("first");
    const second = createEditorInstanceId("second");
    const store = useEditorSessionStore.getState();

    store.setDocumentDirty(key, true, first);
    store.setDocumentDirty(key, true, second);
    store.setDocumentDirty(key, false, first);

    expect(useEditorSessionStore.getState().isDocumentDirty(key)).toBe(true);
    expect(
      useEditorSessionStore.getState().dirtyDocumentIds.has("entry-1"),
    ).toBe(true);

    store.setDocumentDirty(key, false, second);
    expect(useEditorSessionStore.getState().isDocumentDirty(key)).toBe(false);
    expect(
      useEditorSessionStore.getState().dirtyDocumentIds.has("entry-1"),
    ).toBe(false);
  });

  it("does not mix Codex base and Phase dirty state", () => {
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
    const store = useEditorSessionStore.getState();

    store.setDocumentDirty(phase, true, createEditorInstanceId("phase"));

    expect(useEditorSessionStore.getState().isDocumentDirty(phase)).toBe(true);
    expect(useEditorSessionStore.getState().isDocumentDirty(base)).toBe(false);
  });

  it("preserves the legacy raw-id API for non-pane callers", () => {
    const store = useEditorSessionStore.getState();
    store.setDocumentDirty("scene-1", true);
    expect(useEditorSessionStore.getState().dirtyDocumentIds).toContain(
      "scene-1",
    );
    store.setDocumentDirty("scene-1", false);
    expect(useEditorSessionStore.getState().dirtyDocumentIds).not.toContain(
      "scene-1",
    );
  });
});
