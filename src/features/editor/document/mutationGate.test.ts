import { describe, expect, it } from "vitest";
import { createEditorMutationGate, type SaveSnapshot } from "./mutationGate";
import type { LoadedEditorBinding } from "./types";

const binding: LoadedEditorBinding = {
  kind: "tree",
  id: "scene-1",
  nodeType: "scene",
  storage: "database",
  loadedVersion: 0,
};

describe("EditorMutationGate", () => {
  it("does not expose a save target before a successful load", () => {
    const gate = createEditorMutationGate();

    expect(gate.captureSave()).toBeNull();
    gate.beginLoad();
    expect(gate.captureSave()).toBeNull();
    gate.failLoad();
    expect(gate.captureSave()).toBeNull();
  });

  it("commits one atomic binding after load", () => {
    const gate = createEditorMutationGate();

    gate.commitLoad(binding);

    expect(gate.captureSave()).toEqual({ binding, editGeneration: 0 });
  });

  it("does not count programmatic updates as edits", () => {
    const gate = createEditorMutationGate();
    gate.commitLoad(binding);

    gate.runProgrammatic(() => {
      expect(gate.isProgrammatic()).toBe(true);
      gate.markEdited();
    });

    expect(gate.isProgrammatic()).toBe(false);
    expect(gate.captureSave()).toEqual({ binding, editGeneration: 0 });
  });

  it("keeps dirty when an edit arrives while saving", () => {
    const gate = createEditorMutationGate();
    gate.commitLoad(binding);
    const snapshot = gate.captureSave() as SaveSnapshot;

    gate.markEdited();

    expect(gate.mayClearDirty(snapshot)).toBe(false);
  });

  it("does not clear dirty after the binding changes", () => {
    const gate = createEditorMutationGate();
    gate.commitLoad(binding);
    const snapshot = gate.captureSave() as SaveSnapshot;

    gate.beginLoad();
    gate.commitLoad({ ...binding, id: "scene-2" });

    expect(gate.mayClearDirty(snapshot)).toBe(false);
  });

  it("advances the loaded version after a successful save", () => {
    const gate = createEditorMutationGate();
    const versioned: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 5,
    };
    gate.commitLoad(versioned);
    const snapshot = gate.captureSave() as SaveSnapshot;

    expect(gate.commitSave(snapshot, { ...versioned, loadedVersion: 6 })).toBe(
      true,
    );
    expect(gate.captureSave()?.binding).toEqual({
      ...versioned,
      loadedVersion: 6,
    });
  });

  it("advances version but keeps dirty when an edit arrives during save", () => {
    const gate = createEditorMutationGate();
    const versioned: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: null,
      loadedVersion: 8,
    };
    gate.commitLoad(versioned);
    const snapshot = gate.captureSave() as SaveSnapshot;
    gate.markEdited();

    expect(gate.commitSave(snapshot, { ...versioned, loadedVersion: 9 })).toBe(
      false,
    );
    expect(gate.captureSave()?.binding).toMatchObject({ loadedVersion: 9 });
  });

  it("adopts a peer save version without clearing this instance's edits", () => {
    const gate = createEditorMutationGate();
    const versioned: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 4,
    };
    gate.commitLoad(versioned);
    gate.markEdited();

    expect(gate.advancePeerSave({ ...versioned, loadedVersion: 5 })).toBe(true);

    const nextSave = gate.captureSave();
    expect(nextSave?.binding).toEqual({ ...versioned, loadedVersion: 5 });
    expect(gate.mayClearDirty(nextSave as SaveSnapshot)).toBe(true);
  });

  it("ignores peer versions for another document or an older save", () => {
    const gate = createEditorMutationGate();
    const versioned: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: null,
      loadedVersion: 8,
    };
    gate.commitLoad(versioned);

    expect(gate.advancePeerSave({ ...versioned, loadedVersion: 7 })).toBe(
      false,
    );
    expect(
      gate.advancePeerSave({
        kind: "codex",
        id: "codex-2",
        phaseId: null,
        loadedVersion: 9,
      }),
    ).toBe(false);
    expect(gate.captureSave()?.binding).toBe(versioned);
  });
});
