import { describe, expect, it } from "vitest";
import type { PseudoThread } from "@/features/post-effect/PseudoCommentThread";
import {
  buildCommentGroups,
  humanCommentsFromDoc,
  isActiveSceneOutOfScope,
  sortCommentGroups,
  type HumanComment,
} from "./commentsAggregation";

function doc(...content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}
function para(...content: unknown[]) {
  return { type: "paragraph", content };
}
function text(
  value: string,
  comment?: { text?: unknown; createdAt?: unknown },
) {
  return comment
    ? {
        type: "text",
        text: value,
        marks: [{ type: "comment", attrs: comment }],
      }
    : { type: "text", text: value };
}

function fakeThread(
  id: string,
  sceneId: string | null,
  createdAt = "2024-01-01T00:00:00Z",
): PseudoThread {
  return {
    root: { id, sceneId, createdAt },
    replies: [],
  } as unknown as PseudoThread;
}

describe("humanCommentsFromDoc", () => {
  it("captures body (trimmed), quote, and createdAt", () => {
    const json = doc(
      para(
        text("前 "),
        text("ここが対象", { text: "  ここ変  ", createdAt: "2026-01-01" }),
        text(" 後"),
      ),
    );
    expect(humanCommentsFromDoc("scene-1", "Scene One", json)).toEqual([
      {
        sceneId: "scene-1",
        sceneTitle: "Scene One",
        text: "ここ変",
        quote: "ここが対象",
        createdAt: "2026-01-01",
        ordinal: 0,
      },
    ]);
  });

  it("merges contiguous same-mark text nodes into one comment + quote", () => {
    const json = doc(
      para(
        text("ab", { text: "n", createdAt: null }),
        text("cd", { text: "n", createdAt: null }),
      ),
    );
    const out = humanCommentsFromDoc("s", "t", json);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "n", quote: "abcd", ordinal: 0 });
  });

  it("keeps separate comments for differing mark attrs", () => {
    const json = doc(para(text("x", { text: "a" }), text("y", { text: "b" })));
    expect(
      humanCommentsFromDoc("s", "t", json).map((c) => [c.text, c.quote]),
    ).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });

  it("skips empty and whitespace-only bodies", () => {
    const json = doc(
      para(
        text("x", { text: "" }),
        text("y", { text: "   " }),
        text("z", { text: "kept" }),
      ),
    );
    expect(humanCommentsFromDoc("s", "t", json).map((c) => c.text)).toEqual([
      "kept",
    ]);
  });

  it("defaults createdAt to null when absent", () => {
    const json = doc(para(text("x", { text: "x" })));
    expect(humanCommentsFromDoc("s", "t", json)[0].createdAt).toBeNull();
  });

  it("assigns incrementing ordinals to duplicate (text, createdAt) comments", () => {
    const json = doc(
      para(text("一回目", { text: "重複", createdAt: null })),
      para(text("二回目", { text: "重複", createdAt: null })),
    );
    expect(
      humanCommentsFromDoc("s", "t", json).map((c) => [
        c.text,
        c.quote,
        c.ordinal,
      ]),
    ).toEqual([
      ["重複", "一回目", 0],
      ["重複", "二回目", 1],
    ]);
  });

  it("ignores non-comment marks", () => {
    const json = doc(
      para({
        type: "text",
        text: "x",
        marks: [{ type: "authorship", attrs: { source: "ai" } }],
      }),
    );
    expect(humanCommentsFromDoc("s", "t", json)).toEqual([]);
  });

  it("returns [] for empty / invalid JSON", () => {
    expect(humanCommentsFromDoc("s", "t", "{}")).toEqual([]);
    expect(humanCommentsFromDoc("s", "t", "")).toEqual([]);
    expect(humanCommentsFromDoc("s", "t", "not json")).toEqual([]);
  });
});

describe("buildCommentGroups", () => {
  const title = (id: string) => `title:${id}`;
  const human: HumanComment[] = [
    {
      sceneId: "a",
      sceneTitle: "A",
      text: "h1",
      quote: "",
      createdAt: null,
      ordinal: 0,
    },
    {
      sceneId: "a",
      sceneTitle: "A",
      text: "h2",
      quote: "",
      createdAt: null,
      ordinal: 0,
    },
    {
      sceneId: "b",
      sceneTitle: "B",
      text: "h3",
      quote: "",
      createdAt: null,
      ordinal: 0,
    },
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

  it("sceneIds を渡すと対象シーンのグループだけ残る（null は全シーン）", () => {
    const scoped = buildCommentGroups(
      human,
      threads,
      "all",
      title,
      new Set(["a"]),
    );
    expect(scoped.map((g) => g.sceneId)).toEqual(["a"]);
    expect(scoped[0].human.length).toBe(2);
    expect(scoped[0].threads.length).toBe(1);

    const all = buildCommentGroups(human, threads, "all", title, null);
    expect(all.map((g) => g.sceneId).sort()).toEqual(["a", "b", "c"]);
  });

  it("sceneIds が空集合なら全グループが落ちる（scene スコープでシーン未選択）", () => {
    const groups = buildCommentGroups(human, threads, "all", title, new Set());
    expect(groups).toEqual([]);
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

  it("newest/oldest sorts human and pseudo comments into one timeline", () => {
    const human: HumanComment[] = [
      {
        sceneId: "a",
        sceneTitle: "A",
        text: "本文コメント",
        quote: "",
        createdAt: "2024-01-02T00:00:00Z",
        ordinal: 0,
      },
      {
        sceneId: "b",
        sceneTitle: "B",
        text: "別シーン",
        quote: "",
        createdAt: "2024-01-03T00:00:00Z",
        ordinal: 0,
      },
    ];
    const groups = buildCommentGroups(
      human,
      [fakeThread("pseudo-a", "a", "2024-01-01T00:00:00Z")],
      "all",
      title,
    );

    const newest = sortCommentGroups(groups, "newest");
    expect(newest.map((group) => group.sceneId)).toEqual(["b", "a"]);
    expect(newest[1].items.map((item) => item.kind)).toEqual([
      "human",
      "pseudo",
    ]);

    const oldest = sortCommentGroups(groups, "oldest");
    expect(oldest.map((group) => group.sceneId)).toEqual(["a", "b"]);
    expect(oldest[0].items.map((item) => item.kind)).toEqual([
      "pseudo",
      "human",
    ]);
  });
});

describe("isActiveSceneOutOfScope", () => {
  it("folder スコープ相当（集合にアクティブシーンが無い）でのみ true", () => {
    expect(isActiveSceneOutOfScope(new Set(["x"]), "s1")).toBe(true);
    expect(isActiveSceneOutOfScope(new Set(["s1"]), "s1")).toBe(false);
  });

  it("project スコープ（null）とシーン未選択（空文字）は false", () => {
    expect(isActiveSceneOutOfScope(null, "s1")).toBe(false);
    expect(isActiveSceneOutOfScope(new Set(["x"]), "")).toBe(false);
  });
});
