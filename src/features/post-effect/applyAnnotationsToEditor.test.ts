// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import type { Editor } from "@tiptap/core";
import type { PostEffectAnnotation } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnnotation(
  overrides: Partial<PostEffectAnnotation> = {},
): PostEffectAnnotation {
  return {
    id: "ann-1",
    projectId: "proj-1",
    runId: "run-1",
    anchorType: "scene_range",
    sceneId: "scene-1",
    rangeStart: 5,
    rangeEnd: 10,
    textSnapshot: null,
    category: "consistency_anchor",
    persona: null,
    severity: "warning",
    content: "Test annotation",
    authorRole: "ai",
    parentId: null,
    status: "open",
    metadata: "{}",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  } as PostEffectAnnotation;
}

function makeMockEditor(docSize = 100) {
  let commandCallback:
    | ((h: { tr: ReturnType<typeof makeMockTr> }) => boolean)
    | null = null;
  const mockRun = vi.fn();
  const mockCommand = vi
    .fn()
    .mockImplementation((fn: (h: { tr: unknown }) => boolean) => {
      commandCallback = fn as typeof commandCallback;
      return { run: mockRun };
    });
  const mockChain = vi.fn().mockReturnValue({ command: mockCommand });
  const editor = { chain: mockChain } as unknown as Editor;

  function makeMockTr() {
    const mockMarkType = { create: vi.fn().mockReturnValue("MARK") };
    return {
      setMeta: vi.fn(),
      doc: {
        type: { schema: { marks: { peAnnotation: mockMarkType } } },
        content: { size: docSize },
      },
      removeMark: vi.fn(),
      addMark: vi.fn(),
      mockMarkType,
    };
  }

  return {
    editor,
    mockChain,
    mockCommand,
    mockRun,
    invokeCommand: (tr: ReturnType<typeof makeMockTr>) =>
      commandCallback?.({ tr }),
    makeMockTr,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyAnnotationsToEditor", () => {
  it("null editor → does not throw", () => {
    expect(() => applyAnnotationsToEditor(null, [])).not.toThrow();
  });

  it("calls chain().command().run() on editor", () => {
    const { editor, mockChain, mockCommand, mockRun } = makeMockEditor();
    applyAnnotationsToEditor(editor, []);
    expect(mockChain).toHaveBeenCalled();
    expect(mockCommand).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  it("sets programmaticInsert and annotationUpdate meta", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, []);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.setMeta).toHaveBeenCalledWith("programmaticInsert", true);
    expect(tr.setMeta).toHaveBeenCalledWith("annotationUpdate", true);
  });

  it("clears existing marks when docSize > 2", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor(50);
    applyAnnotationsToEditor(editor, []);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.removeMark).toHaveBeenCalledWith(
      1,
      49,
      tr.doc.type.schema.marks.peAnnotation,
    );
  });

  it("dismissed annotations are skipped", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({ id: "ann-1", status: "dismissed" }),
      makeAnnotation({ id: "ann-2", status: "open" }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.addMark).toHaveBeenCalledTimes(1);
  });

  it("annotations with null rangeStart/rangeEnd are skipped", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({
        rangeStart: null as unknown as number,
        rangeEnd: null as unknown as number,
      }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.addMark).not.toHaveBeenCalled();
  });

  it("positions are clamped to docSize", () => {
    const docSize = 8;
    const { editor, invokeCommand, makeMockTr } = makeMockEditor(docSize);
    applyAnnotationsToEditor(editor, [
      makeAnnotation({ rangeStart: 3, rangeEnd: 999 }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    const [cf, ct] = tr.addMark.mock.calls[0] as [number, number, unknown];
    expect(cf).toBe(3);
    expect(ct).toBe(docSize);
  });

  it("mark is created with correct annotation attributes", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({
        id: "my-id",
        category: "consistency_anchor",
        severity: "error",
        status: "open",
      }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.mockMarkType.create).toHaveBeenCalledWith({
      annotationId: "my-id",
      category: "consistency_anchor",
      severity: "error",
      status: "open",
    });
  });

  it("null severity defaults to 'warning'", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [makeAnnotation({ severity: null })]);
    const tr = makeMockTr();
    invokeCommand(tr);
    const attrs = tr.mockMarkType.create.mock.calls[0][0] as {
      severity: string;
    };
    expect(attrs.severity).toBe("warning");
  });
});
