// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { insertTrashItemIntoEditor } from "./editorInsert";
import type { TrashItemData } from "./types";

function createTestEditor(content = "<p></p>"): Editor {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
}

function authorshipSources(editor: Editor): string[] {
  const sources: string[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    if (mark) sources.push(mark.attrs.source as string);
  });
  return sources;
}

function makeTextFragmentItem(
  spans: Array<{ text: string; source: "human" | "ai" | "unknown" }>,
): TrashItemData {
  const text = spans.map((s) => s.text).join("");
  return {
    id: "frag-1",
    projectId: "p",
    kind: "text-fragment",
    subKind: "text-fragment",
    originSceneId: null,
    originCodexId: null,
    previewText: text,
    previewMeta: null,
    payload: {
      text,
      spans: spans.map((s) => ({
        text: s.text,
        source: s.source,
        model: null,
        chatMessageId: null,
        traceId: null,
        timestamp: null,
      })),
    },
    charCount: [...text].length,
    isInteresting: false,
    deletedAt: new Date().toISOString(),
  };
}

describe("insertTrashItemIntoEditor — text-fragment", () => {
  let editor: Editor;
  beforeEach(() => {
    editor = createTestEditor("<p></p>");
  });
  afterEach(() => editor.destroy());

  it("inserts spans with authorship marks preserved", () => {
    const item = makeTextFragmentItem([
      { text: "人間が書いた", source: "human" },
      { text: "AIが書いた", source: "ai" },
    ]);
    const inserted = insertTrashItemIntoEditor(editor, item);
    expect(inserted).toBeGreaterThan(0);
    const sources = authorshipSources(editor);
    expect(sources).toContain("human");
    expect(sources).toContain("ai");
  });

  it("falls back to text when spans is empty", () => {
    const item: TrashItemData = {
      ...makeTextFragmentItem([]),
      payload: { text: "fallback", spans: [] },
      previewText: "fallback",
    };
    const inserted = insertTrashItemIntoEditor(editor, item);
    expect(inserted).toBe([..."fallback"].length);
    expect(editor.getText()).toContain("fallback");
  });

  it("returns 0 for empty payload", () => {
    const item: TrashItemData = {
      ...makeTextFragmentItem([]),
      payload: { text: "", spans: [] },
      previewText: "",
    };
    const inserted = insertTrashItemIntoEditor(editor, item);
    expect(inserted).toBe(0);
  });
});

describe("insertTrashItemIntoEditor — structure items", () => {
  let editor: Editor;
  beforeEach(() => {
    editor = createTestEditor("<p></p>");
  });
  afterEach(() => editor.destroy());

  it("inserts scene as title + body text", () => {
    const item: TrashItemData = {
      id: "scene-1",
      projectId: "p",
      kind: "structure-item",
      subKind: "scene",
      originSceneId: null,
      originCodexId: null,
      previewText: "シーン1",
      previewMeta: null,
      payload: {
        originalId: "old-1",
        title: "シーン1",
        body: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"本文だ"}]}]}',
        beats: "[]",
        povCharacterId: null,
        folderHintId: null,
        folderHintName: null,
        metadata: {
          synopsis: null,
          status: null,
          nodeType: "scene",
          locationId: null,
          sortOrder: "1",
          storyTimeOrder: null,
          storyTimeLabel: null,
        },
        charCount: 3,
      },
      charCount: 3,
      isInteresting: false,
      deletedAt: new Date().toISOString(),
    };
    const inserted = insertTrashItemIntoEditor(editor, item);
    expect(inserted).toBeGreaterThan(0);
    const text = editor.getText();
    expect(text).toContain("シーン1");
    expect(text).toContain("本文だ");
  });
});
