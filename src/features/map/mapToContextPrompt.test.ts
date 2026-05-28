import { describe, it, expect } from "vitest";
import type {
  MapSticky,
  MapEdge,
  MapFrame,
  MapNodePosition,
} from "@/db/schema";
import {
  buildMapContextMarkdown,
  type ResolvedLabel,
} from "./mapToContextPrompt";

const ISO = "2026-01-01T00:00:00.000Z";

function sticky(
  partial: Partial<MapSticky> & { id: string; title: string },
): MapSticky {
  return {
    boardId: "b1",
    body: '{"type":"doc","content":[]}',
    previewText: null,
    paletteId: "post-it-playful",
    colorSlot: 0,
    aiBranchId: null,
    sourceChatMessageId: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...partial,
  } as MapSticky;
}

function pos(
  partial: Partial<MapNodePosition> & {
    id: string;
    nodeRefType: MapNodePosition["nodeRefType"];
    x: number;
    y: number;
  },
): MapNodePosition {
  return {
    id: partial.id,
    boardId: "b1",
    nodeRefType: partial.nodeRefType,
    treeNodeId: partial.treeNodeId ?? null,
    codexEntryId: partial.codexEntryId ?? null,
    snippetId: partial.snippetId ?? null,
    stickyId: partial.stickyId ?? null,
    aiBranchId: partial.aiBranchId ?? null,
    x: partial.x,
    y: partial.y,
    pinned: 0,
    zIndex: 0,
    createdAt: ISO,
    updatedAt: ISO,
  } as MapNodePosition;
}

function frame(
  partial: Partial<MapFrame> & {
    id: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
  },
): MapFrame {
  return {
    id: partial.id,
    boardId: "b1",
    title: partial.title,
    x: partial.x,
    y: partial.y,
    width: partial.width,
    height: partial.height,
    background: "#fff",
    borderColor: "#000",
    zIndex: partial.zIndex ?? -1,
    createdAt: ISO,
    updatedAt: ISO,
  } as MapFrame;
}

function edge(
  partial: Partial<MapEdge> & {
    id: string;
    fromPositionId: string;
    toPositionId: string;
  },
): MapEdge {
  return {
    id: partial.id,
    boardId: "b1",
    fromPositionId: partial.fromPositionId,
    toPositionId: partial.toPositionId,
    forwardLabel: partial.forwardLabel ?? null,
    backwardLabel: partial.backwardLabel ?? null,
    labels: "[]",
    style: "solid",
    color: "#000",
    direction: partial.direction ?? "none",
    createdAt: ISO,
    updatedAt: ISO,
  } as MapEdge;
}

function pmDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

const noResolve = (): ResolvedLabel | null => null;

describe("buildMapContextMarkdown", () => {
  it("空 board は (empty board) タグだけ返す", () => {
    const out = buildMapContextMarkdown({
      boardTitle: "My Board",
      stickies: [],
      edges: [],
      frames: [],
      positions: [],
      resolveLabel: noResolve,
    });
    expect(out).toBe('<map board="My Board">\n(empty board)\n</map>');
  });

  it("Frame 内 Sticky と Floating Sticky を分けて出力", () => {
    const stickies = [
      sticky({ id: "s1", title: "預言の書", body: pmDoc("古文書") }),
      sticky({ id: "s2", title: "無所属メモ" }),
    ];
    const positions = [
      pos({ id: "p1", nodeRefType: "sticky", stickyId: "s1", x: 100, y: 100 }),
      pos({ id: "p2", nodeRefType: "sticky", stickyId: "s2", x: 500, y: 500 }),
    ];
    const frames = [
      frame({
        id: "f1",
        title: "神話編",
        x: 50,
        y: 50,
        width: 300,
        height: 300,
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges: [],
      frames,
      positions,
      resolveLabel: noResolve,
    });
    expect(out).toContain("## Frame: 神話編");
    expect(out).toContain("- **預言の書** (Sticky)");
    expect(out).toContain("  古文書");
    expect(out).toContain("## Floating (frame 外)");
    expect(out).toContain("- **無所属メモ** (Sticky)");
  });

  it("Sticky 同士の forward edge は forwardLabel 付き矢印", () => {
    const stickies = [
      sticky({ id: "s1", title: "A" }),
      sticky({ id: "s2", title: "B" }),
    ];
    const positions = [
      pos({ id: "p1", nodeRefType: "sticky", stickyId: "s1", x: 0, y: 0 }),
      pos({ id: "p2", nodeRefType: "sticky", stickyId: "s2", x: 200, y: 0 }),
    ];
    const edges = [
      edge({
        id: "e1",
        fromPositionId: "p1",
        toPositionId: "p2",
        forwardLabel: "託す",
        direction: "forward",
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges,
      frames: [],
      positions,
      resolveLabel: noResolve,
    });
    expect(out).toContain('[Sticky] "A" → [Sticky] "B": 託す');
  });

  it("bidirectional edge は forward/backward 両方ラベル化", () => {
    const stickies = [
      sticky({ id: "s1", title: "A" }),
      sticky({ id: "s2", title: "B" }),
    ];
    const positions = [
      pos({ id: "p1", nodeRefType: "sticky", stickyId: "s1", x: 0, y: 0 }),
      pos({ id: "p2", nodeRefType: "sticky", stickyId: "s2", x: 200, y: 0 }),
    ];
    const edges = [
      edge({
        id: "e1",
        fromPositionId: "p1",
        toPositionId: "p2",
        forwardLabel: "提示",
        backwardLabel: "回収",
        direction: "bidirectional",
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges,
      frames: [],
      positions,
      resolveLabel: noResolve,
    });
    expect(out).toContain('[Sticky] "A" ↔ [Sticky] "B": (→ 提示) / (← 回収)');
  });

  it("direction=none は ─ で結ぶ", () => {
    const stickies = [
      sticky({ id: "s1", title: "A" }),
      sticky({ id: "s2", title: "B" }),
    ];
    const positions = [
      pos({ id: "p1", nodeRefType: "sticky", stickyId: "s1", x: 0, y: 0 }),
      pos({ id: "p2", nodeRefType: "sticky", stickyId: "s2", x: 200, y: 0 }),
    ];
    const edges = [
      edge({
        id: "e1",
        fromPositionId: "p1",
        toPositionId: "p2",
        direction: "none",
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges,
      frames: [],
      positions,
      resolveLabel: noResolve,
    });
    expect(out).toContain('[Sticky] "A" ─ [Sticky] "B"');
  });

  it("Heterogeneous edge (Sticky → Codex / Scene / AIBranch) は resolveLabel を経由", () => {
    const stickies = [sticky({ id: "s1", title: "主人公" })];
    const positions = [
      pos({ id: "ps", nodeRefType: "sticky", stickyId: "s1", x: 0, y: 0 }),
      pos({
        id: "pc",
        nodeRefType: "codex",
        codexEntryId: "c1",
        x: 200,
        y: 0,
      }),
      pos({
        id: "pscene",
        nodeRefType: "scene",
        treeNodeId: "t1",
        x: 0,
        y: 200,
      }),
      pos({
        id: "pai",
        nodeRefType: "ai_branch",
        aiBranchId: "a1",
        x: 200,
        y: 200,
      }),
    ];
    const edges = [
      edge({
        id: "e1",
        fromPositionId: "ps",
        toPositionId: "pc",
        forwardLabel: "契約者",
        direction: "forward",
      }),
      edge({
        id: "e2",
        fromPositionId: "pscene",
        toPositionId: "ps",
        forwardLabel: "登場",
        direction: "forward",
      }),
      edge({
        id: "e3",
        fromPositionId: "ps",
        toPositionId: "pai",
        forwardLabel: "候補",
        direction: "forward",
      }),
    ];
    const resolveLabel = (p: MapNodePosition): ResolvedLabel | null => {
      if (p.nodeRefType === "codex")
        return { kind: "codex", title: "神獣リン" };
      if (p.nodeRefType === "scene") return { kind: "scene", title: "第一話" };
      if (p.nodeRefType === "ai_branch")
        return { kind: "ai_branch", title: "案#3" };
      return null;
    };
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges,
      frames: [],
      positions,
      resolveLabel,
    });
    expect(out).toContain('[Sticky] "主人公" → [Codex] "神獣リン": 契約者');
    expect(out).toContain('[Scene] "第一話" → [Sticky] "主人公": 登場');
    expect(out).toContain('[Sticky] "主人公" → [AIBranch] "案#3": 候補');
  });

  it("resolveLabel が null を返した endpoint の edge はスキップ", () => {
    const stickies = [sticky({ id: "s1", title: "A" })];
    const positions = [
      pos({ id: "ps", nodeRefType: "sticky", stickyId: "s1", x: 0, y: 0 }),
      pos({
        id: "pmissing",
        nodeRefType: "codex",
        codexEntryId: "deleted",
        x: 200,
        y: 0,
      }),
    ];
    const edges = [
      edge({
        id: "e1",
        fromPositionId: "ps",
        toPositionId: "pmissing",
        direction: "forward",
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges,
      frames: [],
      positions,
      resolveLabel: () => null,
    });
    expect(out).not.toContain("## Edges");
  });

  it("空セクション (members なしの Frame) は出力されない", () => {
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies: [],
      edges: [],
      frames: [
        frame({
          id: "f1",
          title: "Empty",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        }),
      ],
      positions: [],
      resolveLabel: noResolve,
    });
    expect(out).not.toContain("## Frame: Empty");
  });

  it("空 title の Sticky は (untitled xxxxxx) でフォールバック", () => {
    const stickies = [sticky({ id: "stk-abc1234567", title: "" })];
    const positions = [
      pos({
        id: "p1",
        nodeRefType: "sticky",
        stickyId: "stk-abc1234567",
        x: 0,
        y: 0,
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges: [],
      frames: [],
      positions,
      resolveLabel: noResolve,
    });
    expect(out).toContain("(untitled stk-ab)");
  });

  it("forward edge で forwardLabel が空なら矢印のみ", () => {
    const stickies = [
      sticky({ id: "s1", title: "A" }),
      sticky({ id: "s2", title: "B" }),
    ];
    const positions = [
      pos({ id: "p1", nodeRefType: "sticky", stickyId: "s1", x: 0, y: 0 }),
      pos({ id: "p2", nodeRefType: "sticky", stickyId: "s2", x: 200, y: 0 }),
    ];
    const edges = [
      edge({
        id: "e1",
        fromPositionId: "p1",
        toPositionId: "p2",
        direction: "forward",
      }),
    ];
    const out = buildMapContextMarkdown({
      boardTitle: "B",
      stickies,
      edges,
      frames: [],
      positions,
      resolveLabel: noResolve,
    });
    expect(out).toMatch(/\[Sticky\] "A" → \[Sticky\] "B"$/m);
  });
});
