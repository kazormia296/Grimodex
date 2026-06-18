// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

// vi.mock() は巻き上げが必要なので vi.hoisted() で参照を確保する
const { updateAnnotationStatusMock } = vi.hoisted(() => ({
  updateAnnotationStatusMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./api", () => ({
  updateAnnotationStatus: updateAnnotationStatusMock,
}));

// closeAnnotation は現在プロジェクトを useTreeStore から取って XPROJ ガードに渡す
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p" }) },
}));

import { useAnnotationStore } from "./annotationStore";
import { closeAnnotation } from "./closeAnnotation";
import { AnnotationMark } from "./AnnotationMark";
import type { PostEffectAnnotation } from "./types";

function makeEditor(text: string): Editor {
  return new Editor({
    extensions: [StarterKit, AnnotationMark],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

function ann(id: string, found: string): PostEffectAnnotation {
  return {
    id,
    projectId: "p",
    runId: "r",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart: 0,
    rangeEnd: found.length,
    textSnapshot: found,
    category: "typo_anchor",
    persona: null,
    severity: "warning",
    content: "",
    authorRole: "ai",
    parentId: null,
    status: "open",
    metadata: JSON.stringify({
      dismiss_key: "k",
      typo_ref: {
        category: "homophone",
        found_text: found,
        suggestion: "x",
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

describe("closeAnnotation", () => {
  it("updates DB and store status, and refreshes editor marks", async () => {
    const editor = makeEditor("シュミレーション");
    const a = ann("a1", "シュミレーション");
    useAnnotationStore.getState().setAnnotations("s1", [a]);

    await closeAnnotation(a, "resolved", editor);

    expect(updateAnnotationStatusMock).toHaveBeenCalledWith(
      "a1",
      "resolved",
      "p",
    );
    const stored = useAnnotationStore.getState().annotationsByScene.get("s1");
    expect(stored?.find((x) => x.id === "a1")?.status).toBe("resolved");
    editor.destroy();
  });

  it("still updates store when DB fails", async () => {
    updateAnnotationStatusMock.mockRejectedValueOnce(new Error("db down"));
    const editor = makeEditor("シュミレーション");
    const a = ann("a1", "シュミレーション");
    useAnnotationStore.getState().setAnnotations("s1", [a]);

    await closeAnnotation(a, "dismissed", editor);

    const stored = useAnnotationStore.getState().annotationsByScene.get("s1");
    expect(stored?.find((x) => x.id === "a1")?.status).toBe("dismissed");
    editor.destroy();
  });

  it("works without editor (no mark refresh, but DB/store still update)", async () => {
    const a = ann("a1", "x");
    useAnnotationStore.getState().setAnnotations("s1", [a]);

    await closeAnnotation(a, "resolved", null);

    expect(updateAnnotationStatusMock).toHaveBeenCalledWith(
      "a1",
      "resolved",
      "p",
    );
    const stored = useAnnotationStore.getState().annotationsByScene.get("s1");
    expect(stored?.find((x) => x.id === "a1")?.status).toBe("resolved");
  });
});
