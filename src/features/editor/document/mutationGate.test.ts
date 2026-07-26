import { describe, expect, it } from "vitest";
import { createEditorMutationGate, type SaveSnapshot } from "./mutationGate";
import type { LoadedEditorBinding } from "./types";

const binding: LoadedEditorBinding = {
  kind: "tree",
  id: "scene-1",
  nodeType: "scene",
  storage: "database",
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
});
