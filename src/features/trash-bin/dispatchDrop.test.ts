// @vitest-environment happy-dom
/**
 * dispatchDrop の編集系経路で「ドロップされた pane の Editor」が
 * 優先されることを検証する回帰テスト (advisor 指摘の focus/drop ずれ修正)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { dispatchDrop } from "./pickupHandlers";
import {
  useFocusedContentEditorStore,
  getFocusedEditor,
} from "@/store/focusedContentEditorStore";
import type { DropTarget } from "@/store/dropTargetRegistry";
import type { TrashItemData } from "./types";

const { restoreStructuralTrashItemMock } = vi.hoisted(() => ({
  restoreStructuralTrashItemMock: vi.fn(),
}));
vi.mock("./api", () => ({
  restoreStructuralTrashItem: restoreStructuralTrashItemMock,
}));

function makeEditor(initial = "<p></p>"): Editor {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content: initial,
  });
}

function makeFragment(text: string): TrashItemData {
  return {
    id: "f1",
    projectId: "p",
    kind: "text-fragment",
    subKind: "text-fragment",
    originSceneId: null,
    originCodexId: null,
    previewText: text,
    previewMeta: null,
    payload: {
      text,
      spans: [
        {
          text,
          source: "human",
          model: null,
          chatMessageId: null,
          traceId: null,
          timestamp: null,
        },
      ],
    },
    charCount: [...text].length,
    isInteresting: false,
    deletedAt: new Date().toISOString(),
  };
}

function makeTarget(
  kind: DropTarget["kind"],
  editor: Editor | null,
): DropTarget {
  return {
    id: `${kind}-test`,
    kind,
    rect: () => null,
    accepts: () => true,
    onDrop: async () => {},
    getEditor: () => editor,
  };
}

describe("dispatchDrop editor target", () => {
  let focusedEditor: Editor;
  let droppedEditor: Editor;

  beforeEach(() => {
    restoreStructuralTrashItemMock.mockReset();
    focusedEditor = makeEditor();
    droppedEditor = makeEditor();
    useFocusedContentEditorStore
      .getState()
      .setCurrent({ kind: "scene", id: "focused" }, focusedEditor);
  });

  afterEach(() => {
    focusedEditor.destroy();
    droppedEditor.destroy();
    useFocusedContentEditorStore.getState().setCurrent(null, null);
  });

  it("inserts into target.getEditor() editor, not the focused one", async () => {
    // Sanity: focused editor is the registered one
    expect(getFocusedEditor()).toBe(focusedEditor);

    const result = await dispatchDrop(
      makeFragment("DROPPED"),
      makeTarget("scene-editor", droppedEditor),
      { x: 0, y: 0 },
    );
    expect(result.ok).toBe(true);
    expect(droppedEditor.getText()).toContain("DROPPED");
    expect(focusedEditor.getText()).not.toContain("DROPPED");
  });

  it("falls back to focused editor when target.getEditor returns null", async () => {
    const result = await dispatchDrop(
      makeFragment("FALLBACK"),
      makeTarget("scene-editor", null),
      { x: 0, y: 0 },
    );
    expect(result.ok).toBe(true);
    expect(focusedEditor.getText()).toContain("FALLBACK");
  });

  it("rejects when no editor is available", async () => {
    useFocusedContentEditorStore.getState().setCurrent(null, null);
    const result = await dispatchDrop(
      makeFragment("X"),
      makeTarget("scene-editor", null),
      { x: 0, y: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-target");
    }
  });

  it("routes structural panel restore through one Native aggregate", async () => {
    restoreStructuralTrashItemMock.mockResolvedValue({
      newId: "restored-scene:trash-scene",
      brokenLinks: [],
    });
    const item: TrashItemData = {
      id: "trash-scene",
      projectId: "p1",
      kind: "structure-item",
      subKind: "scene",
      originSceneId: null,
      originCodexId: null,
      previewText: "Scene",
      previewMeta: null,
      payload: {
        originalId: "old-scene",
        title: "Scene",
        body: "{}",
        beats: "[]",
        povCharacterId: null,
        folderHintId: null,
        folderHintName: null,
        metadata: {
          synopsis: null,
          status: null,
          nodeType: "scene",
          locationId: null,
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
        },
        charCount: 0,
      },
      charCount: 5,
      isInteresting: true,
      deletedAt: "2026-08-13T00:00:00.000Z",
    };

    const result = await dispatchDrop(
      item,
      makeTarget("scenes-panel", null),
      { x: 0, y: 0 },
      "p1",
    );

    expect(result).toEqual({
      ok: true,
      newId: "restored-scene:trash-scene",
      brokenLinks: [],
    });
    expect(restoreStructuralTrashItemMock).toHaveBeenCalledWith(item, {});
  });
});
