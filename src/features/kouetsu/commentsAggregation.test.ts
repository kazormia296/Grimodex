import { describe, expect, it } from "vitest";
import type { ExtractedMark } from "@/features/export/zipExport/marksExtractor";
import type { PseudoThread } from "@/features/post-effect/PseudoCommentThread";
import {
  buildCommentGroups,
  humanCommentsFromMarks,
  type HumanComment,
} from "./commentsAggregation";

function commentMark(
  attrs: Record<string, unknown>,
  type: ExtractedMark["type"] = "comment",
): ExtractedMark {
  return { type, from: 0, to: 1, attrs };
}

function fakeThread(id: string, sceneId: string | null): PseudoThread {
  return {
    root: { id, sceneId },
    replies: [],
  } as unknown as PseudoThread;
}

describe("humanCommentsFromMarks", () => {
  it("maps comment marks, trimming text and carrying createdAt", () => {
    const marks: ExtractedMark[] = [
      commentMark({ text: "  hello  ", createdAt: "2026-01-01" }),
    ];
    const out = humanCommentsFromMarks("scene-1", "Scene One", marks);
    expect(out).toEqual([
      {
        sceneId: "scene-1",
        sceneTitle: "Scene One",
        text: "hello",
        createdAt: "2026-01-01",
      },
    ]);
  });

  it("skips empty and whitespace-only text", () => {
    const marks: ExtractedMark[] = [
      commentMark({ text: "" }),
      commentMark({ text: "   " }),
      commentMark({ text: "\n\t " }),
      commentMark({}),
      commentMark({ text: "kept" }),
    ];
    const out = humanCommentsFromMarks("s", "t", marks);
    expect(out.map((c) => c.text)).toEqual(["kept"]);
  });

  it("skips non-comment marks", () => {
    const marks: ExtractedMark[] = [
      commentMark({ text: "auth" }, "authorship"),
      commentMark({ text: "ann" }, "annotation"),
      commentMark({ text: "real comment" }),
    ];
    const out = humanCommentsFromMarks("s", "t", marks);
    expect(out.map((c) => c.text)).toEqual(["real comment"]);
  });

  it("defaults createdAt to null when absent", () => {
    const out = humanCommentsFromMarks("s", "t", [commentMark({ text: "x" })]);
    expect(out[0].createdAt).toBeNull();
  });
});

describe("buildCommentGroups", () => {
  const title = (id: string) => `title:${id}`;
  const human: HumanComment[] = [
    { sceneId: "a", sceneTitle: "A", text: "h1", createdAt: null },
    { sceneId: "a", sceneTitle: "A", text: "h2", createdAt: null },
    { sceneId: "b", sceneTitle: "B", text: "h3", createdAt: null },
  ];
  const threads: PseudoThread[] = [
    fakeThread("t1", "a"),
    fakeThread("t2", "c"),
  ];

  it("filter 'all' merges human and threads per scene with correct counts", () => {
    const groups = buildCommentGroups(human, threads, "all", title);
    const byScene = new Map(groups.map((g) => [g.sceneId, g]));

    expect(byScene.get("a")?.human.length).toBe(2);
    expect(byScene.get("a")?.threads.length).toBe(1);
    expect(byScene.get("b")?.human.length).toBe(1);
    expect(byScene.get("b")?.threads.length).toBe(0);
    expect(byScene.get("c")?.human.length).toBe(0);
    expect(byScene.get("c")?.threads.length).toBe(1);

    for (const g of groups) {
      const count = g.human.length + g.threads.length;
      expect(count).toBeGreaterThan(0);
    }
    expect(byScene.get("a")?.sceneTitle).toBe("title:a");
  });

  it("filter 'human' drops threads", () => {
    const groups = buildCommentGroups(human, threads, "human", title);
    expect(groups.every((g) => g.threads.length === 0)).toBe(true);
    expect(groups.map((g) => g.sceneId).sort()).toEqual(["a", "b"]);
  });

  it("filter 'ai' drops human", () => {
    const groups = buildCommentGroups(human, threads, "ai", title);
    expect(groups.every((g) => g.human.length === 0)).toBe(true);
    expect(groups.map((g) => g.sceneId).sort()).toEqual(["a", "c"]);
  });

  // NOTE: buildCommentGroups never creates an empty group (every ensure() is
  // followed by a push), so the trailing .filter() is defensive/unreachable.
  // This case only pins the empty-input → empty-output behavior, not the filter.
  it("returns no groups when there are no comments or threads", () => {
    const groups = buildCommentGroups([], [], "all", title);
    expect(groups).toEqual([]);
  });

  it("skips a thread whose root.sceneId is null", () => {
    const groups = buildCommentGroups(
      [],
      [fakeThread("orphan", null), fakeThread("ok", "z")],
      "ai",
      title,
    );
    expect(groups.map((g) => g.sceneId)).toEqual(["z"]);
    expect(groups[0].threads.length).toBe(1);
  });
});
