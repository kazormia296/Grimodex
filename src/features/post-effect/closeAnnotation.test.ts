// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

// vi.mock() は巻き上げが必要なので vi.hoisted() で参照を確保する
const { updateAnnotationStatusMock, applyMock } = vi.hoisted(() => ({
  updateAnnotationStatusMock: vi.fn().mockResolvedValue(undefined),
  applyMock: vi.fn(),
}));

vi.mock("./api", () => ({
  updateAnnotationStatus: updateAnnotationStatusMock,
}));

// mark refresh の呼び出し有無を検証するため実装を透過ラップする。
vi.mock("./applyAnnotationsToEditor", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("./applyAnnotationsToEditor")>();
  applyMock.mockImplementation(orig.applyAnnotationsToEditor);
  return { applyAnnotationsToEditor: applyMock };
});

// closeAnnotation は現在プロジェクト（XPROJ ガード）とアクティブシーン
// （mark refresh のシーン一致判定）を useTreeStore から取る。
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p", activeSceneId: "s1" }) },
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

function ann(id: string, found: string, sceneId = "s1"): PostEffectAnnotation {
  return {
    id,
    projectId: "p",
    runId: "r",
    anchorType: "scene_range",
    sceneId,
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
    // アクティブシーン（s1）の annotation なので mark refresh は実行される。
    expect(applyMock).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("別シーンの annotation では mark refresh をスキップする（表示中シーンの下線を消さない）", async () => {
    const editor = makeEditor("表示中シーンの本文");
    // folder/project スコープの統合リストから、非アクティブシーン s2 の指摘を
    // 解決するケース。editor はアクティブシーン s1 の doc を持つため、s2 の
    // annotation 集合を適用すると s1 の下線が全消しになる（回帰ガード）。
    const a = ann("a2", "誤り", "s2");
    useAnnotationStore.getState().setAnnotations("s2", [a]);

    await closeAnnotation(a, "resolved", editor);

    expect(updateAnnotationStatusMock).toHaveBeenCalledWith(
      "a2",
      "resolved",
      "p",
    );
    const stored = useAnnotationStore.getState().annotationsByScene.get("s2");
    expect(stored?.find((x) => x.id === "a2")?.status).toBe("resolved");
    expect(applyMock).not.toHaveBeenCalled();
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
