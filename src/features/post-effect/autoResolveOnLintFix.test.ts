import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { useAnnotationStore } from "./annotationStore";
import {
  applyAutoResolvedTypos,
  collectTypoAnnotationsResolvedByFix,
} from "./autoResolveOnLintFix";
import type { PostEffectAnnotation } from "./types";

vi.mock("./api", () => ({
  updateAnnotationStatus: vi.fn().mockResolvedValue(undefined),
}));

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {},
});

function makeDoc(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
}

function ann(
  id: string,
  found: string,
  suggestion: string,
  range: { start: number; end: number },
): PostEffectAnnotation {
  return {
    id,
    projectId: "p",
    runId: "r",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart: range.start,
    rangeEnd: range.end,
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

describe("collectTypoAnnotationsResolvedByFix", () => {
  it("matches when suggestion equals replacement and ranges overlap", () => {
    const doc = makeDoc("シュミレーションを実行");
    useAnnotationStore.getState().setAnnotations("s1", [
      // textSnapshot=シュミレーション, suggestion=シミュレーション
      ann("a1", "シュミレーション", "シミュレーション", { start: 0, end: 8 }),
    ]);
    // Fix が "シュミレーション" (PM 位置 1..9, paragraph 内オフセット +1) を
    // "シミュレーション" に置換するシナリオ
    const ids = collectTypoAnnotationsResolvedByFix(
      "s1",
      doc,
      1,
      9,
      "シミュレーション",
    );
    expect(ids).toEqual(["a1"]);
  });

  it("skips when replacement does not equal suggestion", () => {
    const doc = makeDoc("シュミレーションを実行");
    useAnnotationStore
      .getState()
      .setAnnotations("s1", [
        ann("a1", "シュミレーション", "シミュレーション", { start: 0, end: 8 }),
      ]);
    const ids = collectTypoAnnotationsResolvedByFix(
      "s1",
      doc,
      1,
      9,
      "別の置換", // 違う replacement
    );
    expect(ids).toEqual([]);
  });

  it("skips when ranges do not overlap", () => {
    const doc = makeDoc("シュミレーションを実行する。短い文。");
    useAnnotationStore
      .getState()
      .setAnnotations("s1", [
        ann("a1", "シュミレーション", "シミュレーション", { start: 0, end: 8 }),
      ]);
    // Fix が末尾の「短い文。」あたり (PM 16..) を置換する想定
    const ids = collectTypoAnnotationsResolvedByFix(
      "s1",
      doc,
      16,
      20,
      "シミュレーション",
    );
    expect(ids).toEqual([]);
  });

  it("normalize ignores trailing punctuation differences", () => {
    const doc = makeDoc("シュミレーション");
    useAnnotationStore.getState().setAnnotations("s1", [
      // suggestion 末尾に句点が付いている
      ann("a1", "シュミレーション", "シミュレーション。", { start: 0, end: 8 }),
    ]);
    const ids = collectTypoAnnotationsResolvedByFix(
      "s1",
      doc,
      1,
      9,
      "シミュレーション",
    );
    expect(ids).toEqual(["a1"]);
  });

  it("ignores non-typo annotations even when ranges/text match", () => {
    const doc = makeDoc("シュミレーション");
    const a = ann("a1", "シュミレーション", "シミュレーション", {
      start: 0,
      end: 8,
    });
    useAnnotationStore.getState().setAnnotations("s1", [
      // 同じ id を consistency_anchor として登録
      { ...a, category: "consistency_anchor" } as PostEffectAnnotation,
    ]);
    const ids = collectTypoAnnotationsResolvedByFix(
      "s1",
      doc,
      1,
      9,
      "シミュレーション",
    );
    expect(ids).toEqual([]);
  });

  it("skips dismissed/resolved typo annotations", () => {
    const doc = makeDoc("シュミレーション");
    const base = ann("a1", "シュミレーション", "シミュレーション", {
      start: 0,
      end: 8,
    });
    useAnnotationStore
      .getState()
      .setAnnotations("s1", [
        { ...base, status: "dismissed" } as PostEffectAnnotation,
      ]);
    const ids = collectTypoAnnotationsResolvedByFix(
      "s1",
      doc,
      1,
      9,
      "シミュレーション",
    );
    expect(ids).toEqual([]);
  });
});

describe("applyAutoResolvedTypos", () => {
  it("updates store status for each id", async () => {
    useAnnotationStore
      .getState()
      .setAnnotations("s1", [
        ann("a1", "x", "y", { start: 0, end: 1 }),
        ann("a2", "p", "q", { start: 1, end: 2 }),
      ]);
    await applyAutoResolvedTypos(["a1", "a2"]);
    const store = useAnnotationStore.getState().annotationsByScene.get("s1");
    expect(store?.find((a) => a.id === "a1")?.status).toBe("resolved");
    expect(store?.find((a) => a.id === "a2")?.status).toBe("resolved");
  });

  it("is a no-op for empty input", async () => {
    await expect(applyAutoResolvedTypos([])).resolves.toBeUndefined();
  });
});
