// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import type { Editor } from "@tiptap/core";
import type { PostEffectAnnotation } from "./types";

// ---------------------------------------------------------------------------
// Real PM schema with the peAnnotation mark — covers the resolver logic that
// `applyAnnotationsToEditor` now delegates to (`resolveAnnotationRange`).
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
  marks: {
    peAnnotation: {
      attrs: {
        annotationId: { default: null },
        category: { default: "consistency_anchor" },
        severity: { default: "warning" },
        status: { default: "open" },
      },
    },
  },
});

function makeDoc(...paragraphs: string[]) {
  return schema.node(
    "doc",
    null,
    paragraphs.map((t) =>
      schema.node("paragraph", null, t ? [schema.text(t)] : []),
    ),
  );
}

function makeAnnotation(
  overrides: Partial<PostEffectAnnotation> = {},
): PostEffectAnnotation {
  return {
    id: "ann-1",
    projectId: "proj-1",
    runId: "run-1",
    anchorType: "scene_range",
    sceneId: "scene-1",
    rangeStart: 1,
    rangeEnd: 4,
    textSnapshot: "abc",
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

function makeMockEditor(doc = makeDoc("abcdef")) {
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
    const markCreate = vi.spyOn(schema.marks["peAnnotation"]!, "create");
    return {
      setMeta: vi.fn(),
      doc,
      removeMark: vi.fn(),
      addMark: vi.fn(),
      markCreate,
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
    // <p>abcdef</p> → docSize = 8 (1 open + 6 chars + 1 close)
    const { editor, invokeCommand, makeMockTr } = makeMockEditor(
      makeDoc("abcdef"),
    );
    applyAnnotationsToEditor(editor, []);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.removeMark).toHaveBeenCalledWith(
      1,
      tr.doc.content.size - 1,
      schema.marks["peAnnotation"],
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

  it("resolved annotations are also skipped (closed annotations don't underline)", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({ id: "ann-1", status: "resolved" }),
      makeAnnotation({ id: "ann-2", status: "open" }),
      makeAnnotation({ id: "ann-3", status: "dismissed" }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.addMark).toHaveBeenCalledTimes(1);
  });

  it("annotations with null textSnapshot AND mismatched PM range are skipped (orphans)", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({
        rangeStart: null as unknown as number,
        rangeEnd: null as unknown as number,
        textSnapshot: null,
      }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.addMark).not.toHaveBeenCalled();
  });

  it("annotations whose textSnapshot is not present in the doc are skipped", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor(
      makeDoc("hello world"),
    );
    applyAnnotationsToEditor(editor, [
      makeAnnotation({ textSnapshot: "ghost", rangeStart: 0, rangeEnd: 5 }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.addMark).not.toHaveBeenCalled();
  });

  it("resolves textSnapshot to real PM positions in the doc", () => {
    // <p>abcdef</p>: "cd" is at flat index 2 → PM positions 3..5
    const { editor, invokeCommand, makeMockTr } = makeMockEditor(
      makeDoc("abcdef"),
    );
    applyAnnotationsToEditor(editor, [
      makeAnnotation({ textSnapshot: "cd", rangeStart: 999, rangeEnd: 1001 }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.addMark).toHaveBeenCalledTimes(1);
    const [from, to] = tr.addMark.mock.calls[0] as [number, number, unknown];
    expect(from).toBe(3);
    expect(to).toBe(5);
  });

  it("mark is created with correct annotation attributes", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({
        id: "my-id",
        textSnapshot: "abc",
        category: "consistency_anchor",
        severity: "error",
        status: "open",
      }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    expect(tr.markCreate).toHaveBeenCalledWith({
      annotationId: "my-id",
      category: "consistency_anchor",
      severity: "error",
      status: "open",
    });
  });

  it("null severity defaults to 'warning'", () => {
    const { editor, invokeCommand, makeMockTr } = makeMockEditor();
    applyAnnotationsToEditor(editor, [
      makeAnnotation({ textSnapshot: "abc", severity: null }),
    ]);
    const tr = makeMockTr();
    invokeCommand(tr);
    const attrs = tr.markCreate.mock.calls[0]?.[0] as { severity: string };
    expect(attrs.severity).toBe("warning");
  });
});
