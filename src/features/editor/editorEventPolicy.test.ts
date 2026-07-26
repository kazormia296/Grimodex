import { describe, expect, it } from "vitest";
import {
  getEditorTimelapseCapture,
  serializeTransactionSteps,
  shouldHandleEditorUpdate,
} from "./editorEventPolicy";

const editor = {};

describe("shouldHandleEditorUpdate", () => {
  it("requires a document-changing transaction", () => {
    expect(
      shouldHandleEditorUpdate({
        docChanged: false,
        isApplyingExternalUpdate: false,
        inlineAiStatus: "idle",
        activeEditor: null,
        editor,
      }),
    ).toBe(false);
  });

  it("rejects programmatic and owner inline-AI updates", () => {
    const base = {
      docChanged: true,
      isApplyingExternalUpdate: false,
      inlineAiStatus: "generating" as const,
      activeEditor: editor,
      editor,
    };

    expect(shouldHandleEditorUpdate(base)).toBe(false);
    expect(
      shouldHandleEditorUpdate({ ...base, isApplyingExternalUpdate: true }),
    ).toBe(false);
  });

  it("keeps non-owner edits and idle edits on the normal path", () => {
    expect(
      shouldHandleEditorUpdate({
        docChanged: true,
        isApplyingExternalUpdate: false,
        inlineAiStatus: "generating",
        activeEditor: {},
        editor,
      }),
    ).toBe(true);
    expect(
      shouldHandleEditorUpdate({
        docChanged: true,
        isApplyingExternalUpdate: false,
        inlineAiStatus: "idle",
        activeEditor: editor,
        editor,
      }),
    ).toBe(true);
  });
});

describe("getEditorTimelapseCapture", () => {
  const base = {
    id: "entry-1",
    isEntryMode: false,
    isCodexMode: false,
    isSnippetMode: false,
    isChronicleEventMode: false,
    isApplyingExternalUpdate: false,
  };

  it("classifies scene, Codex, and snippet bodies", () => {
    expect(getEditorTimelapseCapture(base)).toMatchObject({
      domain: "editor",
      entityType: "scene",
      sceneId: "entry-1",
    });
    expect(
      getEditorTimelapseCapture({ ...base, isCodexMode: true }),
    ).toMatchObject({ domain: "codex", entityType: "codex_entry" });
    expect(
      getEditorTimelapseCapture({ ...base, isSnippetMode: true }),
    ).toMatchObject({ domain: "snippet", entityType: "snippet" });
  });

  it("does not record loads, chronicle details, or untargeted entries", () => {
    expect(
      getEditorTimelapseCapture({ ...base, isApplyingExternalUpdate: true }),
    ).toBeNull();
    expect(
      getEditorTimelapseCapture({ ...base, isChronicleEventMode: true }),
    ).toBeNull();
    expect(getEditorTimelapseCapture({ ...base, id: null })).toBeNull();
    const entryCapture = getEditorTimelapseCapture({
      ...base,
      isEntryMode: true,
    });
    expect(entryCapture).not.toBeNull();
    expect(entryCapture?.sceneId).toBeNull();
  });
});

it("serializes transaction steps without editor dependencies", () => {
  expect(
    serializeTransactionSteps([
      { toJSON: () => ({ step: 1 }) },
      { toJSON: () => ({ step: 2 }) },
    ]),
  ).toEqual([{ step: 1 }, { step: 2 }]);
});
