// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CodexEntry } from "@/features/codex/api";
import type { CrossReferenceEntry } from "@/features/codex/crossReference";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";

// invoke: db_execute_batch の statements を捕捉、それ以外(listBoards の db_execute)は空 rows。
const { mockInvoke, captured } = vi.hoisted(() => {
  const captured: {
    statements: Array<{ sql: string; params: unknown[]; method: string }>;
  } = { statements: [] };
  const mockInvoke = vi.fn(
    async (cmd: string, args: { statements?: typeof captured.statements }) => {
      if (cmd === "db_execute_batch") {
        captured.statements = args.statements ?? [];
        return [];
      }
      return { rows: [] };
    },
  );
  return { mockInvoke, captured };
});
vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

const { listCodexEntriesMock, buildReportMock, listRelationsMock } = vi.hoisted(
  () => ({
    listCodexEntriesMock: vi.fn(),
    buildReportMock: vi.fn(),
    listRelationsMock: vi.fn(),
  }),
);
vi.mock("@/features/codex/api", () => ({
  listCodexEntriesForContext: listCodexEntriesMock,
}));
vi.mock("@/features/codex/crossReference", () => ({
  buildCrossReferenceReportForProject: buildReportMock,
}));
vi.mock("@/features/codex/codexRelationApi", () => ({
  listCodexRelations: listRelationsMock,
}));

import { generateCorrelationBoard } from "./correlationBoard";
import { SyncForceLayoutEngine } from "./layouts/forceEngine";

function character(
  id: string,
  parentId: string | null = null,
  name = id,
): CodexEntry {
  return {
    id,
    projectId: "p1",
    type: "character",
    name,
    parentId,
    tagsCache: null,
  } as unknown as CodexEntry;
}

function lore(id: string, name: string): CodexEntry {
  return {
    id,
    projectId: "p1",
    type: "lore",
    name,
    parentId: null,
    tagsCache: null,
  } as unknown as CodexEntry;
}

function refEntry(entryId: string, sceneIds: string[]): CrossReferenceEntry {
  return {
    entryId,
    entryName: entryId,
    entryType: "character",
    scenes: sceneIds.map((sceneId) => ({
      sceneId,
      sceneTitle: sceneId,
      count: 1,
    })),
  };
}

function byTable(table: string) {
  return captured.statements.filter((s) => s.sql.includes(table));
}

beforeEach(() => {
  captured.statements = [];
  mockInvoke.mockClear();
  listRelationsMock.mockResolvedValue([] as CodexRelationRow[]);
});

const COLS = {
  positions: 14,
  edges: 12,
  frames: 12,
};

describe("generateCorrelationBoard", () => {
  it("writes a board/positions/edges snapshot in one batch with method:'run'", async () => {
    // 120 characters → positions chunking を踏む。c0,c1 だけ 2 シーン共起。
    const chars = Array.from({ length: 120 }, (_, i) => character(`c${i}`));
    listCodexEntriesMock.mockResolvedValue(chars);
    buildReportMock.mockResolvedValue([
      refEntry("c0", ["s1", "s2"]),
      refEntry("c1", ["s1", "s2"]),
    ]);
    listRelationsMock.mockResolvedValue([
      {
        id: "r1",
        projectId: "p1",
        fromCodexId: "c0",
        toCodexId: "c1",
        relationType: "custom",
        label: "親友",
        depthHint: null,
        sourceMapEdgeId: null,
        createdAt: "t",
        updatedAt: "t",
      } as CodexRelationRow,
    ]);

    const result = await generateCorrelationBoard("p1", {
      minSharedScenes: 2,
      includeParentFrames: false,
      engine: new SyncForceLayoutEngine(),
    });

    expect(result.boardId).toMatch(/[0-9a-f-]{36}/);
    expect(mockInvoke).toHaveBeenCalledWith(
      "db_execute_batch",
      expect.anything(),
    );

    // 全 statement は method:"run"
    expect(captured.statements.length).toBeGreaterThan(0);
    for (const s of captured.statements) expect(s.method).toBe("run");

    // board statement: 1 件、mode:"free" と derivedEdges:false
    const boardStmts = byTable("map_boards");
    expect(boardStmts).toHaveLength(1);
    const boardParams = boardStmts[0].params as string[];
    expect(boardParams).toContain("free");
    const showCfg = boardParams.find(
      (p) => typeof p === "string" && p.includes("derivedEdges"),
    );
    expect(showCfg).toContain('"derivedEdges":false');
    expect(showCfg).toContain('"codex":true');
    expect(showCfg).toContain('"userEdges":true');

    // positions: 50 行ごと chunk → 50/50/20、各 statement の変数は 999 以下
    const posStmts = byTable("map_node_positions");
    expect(posStmts).toHaveLength(3);
    const posRows = posStmts.map((s) => s.params.length / COLS.positions);
    expect(posRows).toEqual([50, 50, 20]);
    for (const s of posStmts) expect(s.params.length).toBeLessThanOrEqual(999);

    // edges: 共起 1 + relation 1 = 2 行(同一 statement = 同一キー集合)
    const edgeStmts = byTable("map_edges");
    expect(edgeStmts).toHaveLength(1);
    expect(edgeStmts[0].params.length / COLS.edges).toBe(2);
    // forward_label 列が存在(全行同一キー集合の証拠)
    expect(edgeStmts[0].sql).toContain("forward_label");
    const edgeParams = edgeStmts[0].params as unknown[];
    expect(edgeParams).toContain("親友"); // relation ラベル
    expect(edgeParams).toContain("#7c3aed"); // relation 色
    expect(edgeParams).toContain(null); // 共起エッジの forwardLabel:null

    // frames はオフ → statement 無し(empty insert skip)
    expect(byTable("map_frames")).toHaveLength(0);
  });

  it("skips empty edge inserts and emits parent frames with title column", async () => {
    // 2 characters が同じ親(org1)。共起なし・relation なし。
    const chars = [character("c0", "org1"), character("c1", "org1")];
    listCodexEntriesMock.mockResolvedValue([...chars, lore("org1", "組織A")]);
    buildReportMock.mockResolvedValue([]); // 本文出現なし → 共起ゼロ

    await generateCorrelationBoard("p1", {
      minSharedScenes: 2,
      includeParentFrames: true,
      engine: new SyncForceLayoutEngine(),
    });

    // 共起も relation も無いので edges statement は作らない
    expect(byTable("map_edges")).toHaveLength(0);

    // positions は 1 statement(2 行)
    const posStmts = byTable("map_node_positions");
    expect(posStmts).toHaveLength(1);
    expect(posStmts[0].params.length / COLS.positions).toBe(2);

    // frames: 親グループ 1 件、title カラムに親名
    const frameStmts = byTable("map_frames");
    expect(frameStmts).toHaveLength(1);
    expect(frameStmts[0].params.length / COLS.frames).toBe(1);
    expect(frameStmts[0].params).toContain("組織A");
  });

  it("throws when there are no target characters", async () => {
    listCodexEntriesMock.mockResolvedValue([lore("org1", "組織A")]);
    buildReportMock.mockResolvedValue([]);
    await expect(
      generateCorrelationBoard("p1", {
        minSharedScenes: 2,
        includeParentFrames: false,
        engine: new SyncForceLayoutEngine(),
      }),
    ).rejects.toThrow();
  });
});
