// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CodexEntry } from "@/features/codex/api";
import type { CrossReferenceEntry } from "@/features/codex/crossReference";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";

// map aggregate payload を捕捉、それ以外(listBoards)は空 rows。
const { mockInvoke, captured } = vi.hoisted(() => {
  const captured: { payload: Record<string, unknown> | null } = {
    payload: null,
  };
  const mockInvoke = vi.fn(
    async (cmd: string, args: { payload?: Record<string, unknown> }) => {
      if (cmd === "map_write_bundle") {
        captured.payload = args.payload ?? null;
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

beforeEach(() => {
  captured.payload = null;
  mockInvoke.mockClear();
  listRelationsMock.mockResolvedValue([] as CodexRelationRow[]);
});

describe("generateCorrelationBoard", () => {
  it("writes a board/positions/edges snapshot as one typed aggregate", async () => {
    // 120 characters。c0,c1 だけ 2 シーン共起。
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
      "map_write_bundle",
      expect.anything(),
    );
    expect(captured.payload).toMatchObject({
      kind: "create-board",
      projectId: "p1",
      stickies: [],
      frames: [],
    });
    const board = captured.payload?.board as {
      mode: string;
      showConfig: string;
    };
    expect(board.mode).toBe("free");
    const showCfg = board.showConfig;
    expect(showCfg).toContain('"derivedEdges":false');
    expect(showCfg).toContain('"codex":true');
    expect(showCfg).toContain('"userEdges":true');

    const positions = captured.payload?.positions as unknown[];
    expect(positions).toHaveLength(120);

    const edges = captured.payload?.edges as Array<{
      forwardLabel: string | null;
      color: string;
    }>;
    expect(edges).toHaveLength(2);
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forwardLabel: "親友",
          color: "#7c3aed",
        }),
        expect.objectContaining({ forwardLabel: null }),
      ]),
    );
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

    expect(captured.payload?.edges).toEqual([]);
    expect(captured.payload?.positions).toHaveLength(2);
    expect(captured.payload?.frames).toEqual([
      expect.objectContaining({ title: "組織A" }),
    ]);
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
