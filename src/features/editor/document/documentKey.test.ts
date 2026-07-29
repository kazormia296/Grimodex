import { describe, expect, it } from "vitest";
import {
  createEditorInstanceId,
  documentKeyForEditor,
  documentKeyFromBinding,
  encodeDocumentKey,
} from "./documentKey";

describe("documentKey", () => {
  it("keeps Codex base and Phase bodies distinct", () => {
    const base = encodeDocumentKey({
      kind: "codex",
      id: "entry-1",
      phaseId: null,
    });
    const phase = encodeDocumentKey({
      kind: "codex",
      id: "entry-1",
      phaseId: "phase-1",
    });

    expect(base).not.toBe(phase);
  });

  it("escapes ids so delimiters cannot collide", () => {
    expect(
      encodeDocumentKey({
        kind: "codex",
        id: "entry:phase",
        phaseId: "a:b",
      }),
    ).toBe("codex:entry%3Aphase:phase:a%3Ab");
  });

  it("drops mutable binding fields from the canonical key", () => {
    expect(
      documentKeyFromBinding({
        kind: "tree",
        id: "scene-1",
        nodeType: "note",
        storage: "file",
      }),
    ).toEqual({ kind: "tree", id: "scene-1", storage: "file" });
  });

  it("uses the resolved Phase when building an editor key", () => {
    expect(
      documentKeyForEditor("codex", "entry-1", { phaseId: "phase-2" }),
    ).toEqual({ kind: "codex", id: "entry-1", phaseId: "phase-2" });
  });

  it("assigns a distinct id to every mounted editor instance", () => {
    expect(createEditorInstanceId()).not.toBe(createEditorInstanceId());
  });
});
