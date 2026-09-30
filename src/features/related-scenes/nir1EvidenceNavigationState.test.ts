import { describe, expect, it } from "vitest";
import { createEditorMutationGate } from "@/features/editor/document/mutationGate";
import { encodeDocumentKey } from "@/features/editor/document/documentKey";
import { createLoadedEditorBinding } from "@/features/editor/document/types";
import {
  captureNir1EvidenceEditor,
  createNir1EvidenceNavigationState,
  isNir1EvidenceEditorCurrent,
  type Nir1EvidenceOrigin,
} from "./nir1EvidenceNavigationState";

const origin: Nir1EvidenceOrigin = {
  workspacePath: "/workspace",
  openRevision: 7,
  projectId: "p",
  querySceneId: "s2",
  queryGeneration: 4,
};

function acceptedNavigation() {
  const state = createNir1EvidenceNavigationState();
  const request = state.begin(origin, "s1");
  expect(state.qualify(request, "opaque-backend-binding")).toBe(true);
  expect(state.navigationAccepted(request)).toBe(true);
  return { state, request };
}

describe("NIR-1 own Evidence navigation", () => {
  it("never consumes a merely qualified request before open is accepted", () => {
    const state = createNir1EvidenceNavigationState();
    const request = state.begin(origin, "s1");
    expect(state.qualify(request, "opaque-backend-binding")).toBe(true);
    expect(state.consume({ ...origin, querySceneId: "s1" })).toBeNull();
  });

  it("continues its own S2 to S1 transition and preserves the original query", () => {
    const { state, request } = acceptedNavigation();
    state.observeContext({ ...origin, querySceneId: "s1" });
    expect(state.consume({ ...origin, querySceneId: "s1" })).toEqual({
      requestId: request.requestId,
      origin,
      targetSceneId: "s1",
      bindingKey: "opaque-backend-binding",
    });
    expect(state.consume({ ...origin, querySceneId: "s1" })).toBeNull();
  });

  it("leaves no orphan consumable token when openEditorDocument is blocked", () => {
    const state = createNir1EvidenceNavigationState();
    const request = state.begin(origin, "s1");
    state.qualify(request, "opaque-backend-binding");
    state.navigationBlocked(request);
    expect(state.navigationAccepted(request)).toBe(false);
    expect(state.consume({ ...origin, querySceneId: "s1" })).toBeNull();
  });

  it.each([
    { workspacePath: "/another" },
    { openRevision: 8 },
    { projectId: "another" },
    { querySceneId: "unrelated" },
    { queryGeneration: 5 },
  ])(
    "revokes an accepted navigation after unrelated context change %j",
    (change) => {
      const { state } = acceptedNavigation();
      state.observeContext({ ...origin, ...change });
      expect(state.consume({ ...origin, querySceneId: "s1" })).toBeNull();
    },
  );

  it("does not treat an unaccepted S2 to S1 change as its own navigation", () => {
    const state = createNir1EvidenceNavigationState();
    const request = state.begin(origin, "s1");
    state.qualify(request, "opaque-backend-binding");
    state.observeContext({ ...origin, querySceneId: "s1" });
    expect(state.navigationAccepted(request)).toBe(false);
  });

  it("ignores late completion and blocked callbacks from an older request", () => {
    const state = createNir1EvidenceNavigationState();
    const old = state.begin(origin, "old");
    const current = state.begin(origin, "s1");
    expect(state.qualify(old, "late-binding")).toBe(false);
    state.navigationBlocked(old);
    expect(state.qualify(current, "current-binding")).toBe(true);
    expect(state.navigationAccepted(current)).toBe(true);
    expect(state.consume({ ...origin, querySceneId: "s1" })?.bindingKey).toBe(
      "current-binding",
    );
  });

  it("freezes origin values against caller mutation", () => {
    const state = createNir1EvidenceNavigationState();
    const mutable = { ...origin };
    const request = state.begin(mutable, "s1");
    mutable.queryGeneration = 100;
    expect(request.origin.queryGeneration).toBe(4);
    expect(Object.isFrozen(request.origin)).toBe(true);
  });

  it("revokes on backend invalidation before consumption", () => {
    const { state } = acceptedNavigation();
    state.invalidate();
    expect(state.consume({ ...origin, querySceneId: "s1" })).toBeNull();
  });

  it("does not preserve a token through a return to S2 after reaching S1", () => {
    const { state } = acceptedNavigation();
    state.observeContext({ ...origin, querySceneId: "s1" });
    state.observeContext(origin);
    expect(state.consume({ ...origin, querySceneId: "s1" })).toBeNull();
  });
});

function editorState() {
  const gate = createEditorMutationGate();
  gate.commitLoad(createLoadedEditorBinding("scene", "s1", undefined, null, 5));
  const snapshot = () => ({
    editor: editorIdentity,
    documentKey: encodeDocumentKey({
      kind: "tree",
      id: "s1",
      storage: "database",
    }),
    loadToken: "load-7",
    saveSnapshot: gate.captureSave(),
    isDirty: false,
  });
  const editorIdentity = {};
  return { gate, snapshot };
}

describe("NIR-1 final synchronous editor guard", () => {
  it("allows only the same ready, saved, unmodified editor binding", () => {
    const { snapshot } = editorState();
    const captured = captureNir1EvidenceEditor(snapshot());
    expect(captured).not.toBeNull();
    expect(isNir1EvidenceEditorCurrent(captured, snapshot())).toBe(true);
  });

  it("rejects unsaved edits even if dirty was incorrectly cleared", () => {
    const { gate, snapshot } = editorState();
    const captured = captureNir1EvidenceEditor(snapshot());
    gate.markEdited();
    expect(isNir1EvidenceEditorCurrent(captured, snapshot())).toBe(false);
  });

  it("rejects a successful save after backend verification", () => {
    const { gate, snapshot } = editorState();
    const captured = captureNir1EvidenceEditor(snapshot());
    const save = gate.captureSave();
    if (!save) throw new Error("test binding missing");
    gate.commitSave(
      save,
      createLoadedEditorBinding("scene", "s1", undefined, null, 6),
    );
    expect(isNir1EvidenceEditorCurrent(captured, snapshot())).toBe(false);
  });

  it("rejects reload of the same document and version with a fresh binding", () => {
    const { gate, snapshot } = editorState();
    const captured = captureNir1EvidenceEditor(snapshot());
    gate.beginLoad();
    gate.commitLoad(
      createLoadedEditorBinding("scene", "s1", undefined, null, 5),
    );
    expect(isNir1EvidenceEditorCurrent(captured, snapshot())).toBe(false);
  });

  it.each(["editor", "documentKey", "loadToken", "dirty", "loading"])(
    "rejects changed %s immediately before selection",
    (change) => {
      const { snapshot } = editorState();
      const current = snapshot();
      const captured = captureNir1EvidenceEditor(current);
      if (change === "editor") current.editor = {};
      if (change === "documentKey")
        current.documentKey = encodeDocumentKey({ kind: "snippet", id: "s1" });
      if (change === "loadToken") current.loadToken = "load-8";
      if (change === "dirty") current.isDirty = true;
      if (change === "loading") current.saveSnapshot = null;
      expect(isNir1EvidenceEditorCurrent(captured, current)).toBe(false);
    },
  );

  it("does not capture an already dirty or loading editor", () => {
    const { snapshot } = editorState();
    expect(
      captureNir1EvidenceEditor({ ...snapshot(), isDirty: true }),
    ).toBeNull();
    expect(
      captureNir1EvidenceEditor({ ...snapshot(), saveSnapshot: null }),
    ).toBeNull();
  });

  it("rejects a document key that disagrees with the loaded binding", () => {
    const { snapshot } = editorState();
    expect(
      captureNir1EvidenceEditor({
        ...snapshot(),
        documentKey: encodeDocumentKey({ kind: "snippet", id: "s1" }),
      }),
    ).toBeNull();
  });
});
