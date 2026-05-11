// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

// vi.mock() は巻き上げが必要なので vi.hoisted() で参照を確保する
const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: mockInvoke,
}));

import { AnnotationMark } from "./AnnotationMark";
import {
  extractAnnotationMarks,
  saveAnnotationAnchors,
} from "./syncAnnotations";

function createTestEditor(content = "<p>テスト</p>") {
  return new Editor({
    extensions: [StarterKit, AnnotationMark],
    content,
  });
}

function addAnnotationMark(
  editor: Editor,
  from: number,
  to: number,
  annotationId: string,
  category = "consistency_anchor",
  severity = "warning",
  status = "open",
) {
  editor.view.dispatch(
    editor.state.tr.addMark(
      from,
      to,
      editor.schema.marks["peAnnotation"].create({
        annotationId,
        category,
        severity,
        status,
      }),
    ),
  );
}

describe("extractAnnotationMarks", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createTestEditor();
  });

  it("マークがない場合は空配列を返す", () => {
    const result = extractAnnotationMarks("scene-1", editor.state.doc);
    expect(result).toEqual([]);
    editor.destroy();
  });

  it("アノテーションマークの位置と attrs を正しく抽出する", () => {
    editor.chain().focus().setContent("<p>整合性違反テキスト</p>").run();
    addAnnotationMark(editor, 1, 5, "ann-001", "consistency_anchor", "error");

    const result = extractAnnotationMarks("scene-1", editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ann-001");
    expect(result[0].rangeStart).toBeGreaterThanOrEqual(1);
    expect(result[0].rangeEnd).toBeGreaterThan(result[0].rangeStart);
    editor.destroy();
  });

  it("複数マークを全て抽出する", () => {
    editor.chain().focus().setContent("<p>テキストA</p><p>テキストB</p>").run();
    addAnnotationMark(editor, 1, 4, "ann-A");
    addAnnotationMark(editor, 9, 13, "ann-B");

    const result = extractAnnotationMarks("scene-1", editor.state.doc);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("ann-A");
    expect(ids).toContain("ann-B");
    editor.destroy();
  });

  it("textSnapshot に対象テキストが入る", () => {
    editor.chain().focus().setContent("<p>矛盾箇所</p>").run();
    addAnnotationMark(editor, 1, 4, "ann-snap");

    const result = extractAnnotationMarks("scene-1", editor.state.doc);
    expect(result[0].textSnapshot).toBeTruthy();
    editor.destroy();
  });
});

describe("saveAnnotationAnchors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("アノテーションなしの場合は invoke を呼ばない", async () => {
    const editor = createTestEditor("<p>テキスト</p>");
    await saveAnnotationAnchors("proj-1", "scene-1", editor.state.doc);
    expect(mockInvoke).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("アノテーションがあれば save_post_effect_annotations を invoke する", async () => {
    const editor = createTestEditor("<p>テキスト</p>");
    addAnnotationMark(editor, 1, 4, "ann-001");

    await saveAnnotationAnchors("proj-1", "scene-1", editor.state.doc);
    expect(mockInvoke).toHaveBeenCalledWith(
      "save_post_effect_annotations",
      expect.objectContaining({
        project_id: "proj-1",
        scene_id: "scene-1",
        annotations: expect.arrayContaining([
          expect.objectContaining({ id: "ann-001" }),
        ]),
      }),
    );
    editor.destroy();
  });
});
