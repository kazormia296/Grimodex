// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { groupPseudoThreads } from "./PseudoCommentThread";
import type { PostEffectAnnotation } from "./types";

function a(p: Partial<PostEffectAnnotation>): PostEffectAnnotation {
  return {
    id: "x",
    projectId: "p",
    runId: "r",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart: null,
    rangeEnd: null,
    textSnapshot: null,
    category: "pseudo_comment",
    persona: null,
    severity: null,
    content: "c",
    authorRole: "ai",
    parentId: null,
    status: "open",
    metadata: "{}",
    createdAt: "2024-01-01T00:00:00",
    updatedAt: "2024-01-01T00:00:00",
    ...p,
  } as unknown as PostEffectAnnotation;
}

describe("groupPseudoThreads", () => {
  it("root に返信を parent_id でぶら下げ、createdAt 昇順に並べる", () => {
    const anns = [
      a({ id: "root1", createdAt: "2024-01-02" }),
      a({ id: "root2", createdAt: "2024-01-01" }),
      a({ id: "r1b", parentId: "root1", createdAt: "2024-01-04" }),
      a({ id: "r1a", parentId: "root1", createdAt: "2024-01-03" }),
    ];
    const threads = groupPseudoThreads(anns);
    // root2 (01-01) が先、root1 (01-02) が後
    expect(threads.map((t) => t.root.id)).toEqual(["root2", "root1"]);
    const t1 = threads.find((t) => t.root.id === "root1")!;
    expect(t1.replies.map((r) => r.id)).toEqual(["r1a", "r1b"]);
  });

  it("dismissed の root は除外する", () => {
    const threads = groupPseudoThreads([
      a({ id: "open1", status: "open" }),
      a({ id: "gone", status: "dismissed" }),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["open1"]);
  });

  it("pseudo_comment 以外のカテゴリは無視する", () => {
    const threads = groupPseudoThreads([
      a({ id: "rev", category: "review" }),
      a({ id: "cons", category: "consistency_anchor" }),
      a({ id: "pc", category: "pseudo_comment" }),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["pc"]);
  });

  it("返信の無い root は replies 空配列", () => {
    const threads = groupPseudoThreads([a({ id: "solo" })]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies).toEqual([]);
  });
});
