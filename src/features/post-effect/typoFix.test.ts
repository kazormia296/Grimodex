// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAnnotationStore } from "./annotationStore";
import { applyTypoFixAndResolve } from "./typoFix";
import type { PostEffectAnnotation } from "./types";

vi.mock("./api", () => ({
  updateAnnotationStatus: vi.fn().mockResolvedValue(undefined),
}));

function makeEditor(text: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
  return editor;
}

function ann(
  id: string,
  found: string,
  suggestion: string,
  rangeStart: number,
  rangeEnd: number,
): PostEffectAnnotation {
  return {
    id,
    projectId: "p",
    runId: "r",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart,
    rangeEnd,
    textSnapshot: found,
    category: "typo_anchor",
    persona: null,
    severity: "warning",
    content: "",
    authorRole: "ai",
    parentId: null,
    status: "open",
    metadata: JSON.stringify({
      typo_ref: {
        category: "homophone",
        found_text: found,
        found_context: "",
        suggestion,
        confidence: "high",
        llm_reason: "",
        dismiss_key: "k",
      },
    }),
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
  } as unknown as PostEffectAnnotation;
}

afterEach(() => {
  useAnnotationStore.setState({
    annotationsByScene: new Map(),
    focusedAnnotationId: null,
  });
  vi.clearAllMocks();
});

describe("applyTypoFixAndResolve", () => {
  it("replaces text and marks annotation as resolved", async () => {
    const editor = makeEditor("シュミレーションを実行");
    useAnnotationStore
      .getState()
      .setAnnotations("s1", [
        ann("a1", "シュミレーション", "シミュレーション", 0, 8),
      ]);

    const result = await applyTypoFixAndResolve(
      editor,
      ann("a1", "シュミレーション", "シミュレーション", 0, 8),
    );

    expect(result.applied).toBe(true);
    expect(editor.getText()).toBe("シミュレーションを実行");
    const stored = useAnnotationStore.getState().annotationsByScene.get("s1");
    expect(stored?.find((a) => a.id === "a1")?.status).toBe("resolved");
    editor.destroy();
  });

  it("置換テキストに source='ai' の authorship mark を付与する", async () => {
    const editor = makeEditor("シュミレーションを実行");
    useAnnotationStore
      .getState()
      .setAnnotations("s1", [
        ann("a1", "シュミレーション", "シミュレーション", 0, 8),
      ]);

    const result = await applyTypoFixAndResolve(
      editor,
      ann("a1", "シュミレーション", "シミュレーション", 0, 8),
    );
    expect(result.applied).toBe(true);

    let aiMark: { attrs: Record<string, unknown> } | null = null;
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const m = node.marks.find(
          (mk) => mk.type.name === "authorship" && mk.attrs.source === "ai",
        );
        if (m) aiMark = m as unknown as { attrs: Record<string, unknown> };
      }
    });
    expect(aiMark).not.toBeNull();
    expect(aiMark!.attrs.source).toBe("ai");
    editor.destroy();
  });

  it("returns applied=false when textSnapshot cannot be located", async () => {
    const editor = makeEditor("別の本文");
    const result = await applyTypoFixAndResolve(
      editor,
      ann("a1", "シュミレーション", "シミュレーション", 0, 8),
    );
    expect(result.applied).toBe(false);
    expect(editor.getText()).toBe("別の本文");
    editor.destroy();
  });

  it("returns applied=false when suggestion is empty", async () => {
    const editor = makeEditor("シュミレーション");
    const result = await applyTypoFixAndResolve(
      editor,
      ann("a1", "シュミレーション", "", 0, 8),
    );
    expect(result.applied).toBe(false);
    editor.destroy();
  });

  it("returns applied=false for non-typo annotation", async () => {
    const editor = makeEditor("シュミレーション");
    const consistencyAnn = {
      ...ann("a1", "シュミレーション", "シミュレーション", 0, 8),
      category: "consistency_anchor",
      metadata: JSON.stringify({
        codex_ref: { entry_id: "e", dismiss_key: "k" },
      }),
    } as unknown as PostEffectAnnotation;
    const result = await applyTypoFixAndResolve(editor, consistencyAnn);
    expect(result.applied).toBe(false);
    editor.destroy();
  });

  it("returns applied=false when editor is null", async () => {
    const result = await applyTypoFixAndResolve(
      null,
      ann("a1", "シュミレーション", "シミュレーション", 0, 8),
    );
    expect(result.applied).toBe(false);
  });
});
