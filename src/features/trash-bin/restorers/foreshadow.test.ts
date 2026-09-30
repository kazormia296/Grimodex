import { beforeEach, describe, expect, it, vi } from "vitest";
import { createForeshadow } from "@/features/foreshadow/api";
import { getNode } from "@/features/tree/api";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import type { ForeshadowPayload, TrashItemData } from "../types";
import { restoreForeshadow } from "./foreshadow";

vi.mock("@/features/foreshadow/api", () => ({
  createForeshadow: vi.fn(),
}));
vi.mock("@/features/tree/api", () => ({
  getNode: vi.fn(),
}));

const createMock = vi.mocked(createForeshadow);
const getNodeMock = vi.mocked(getNode);

function item(overrides: Partial<ForeshadowPayload> = {}): TrashItemData {
  return {
    id: "trash-row-1",
    projectId: "p1",
    kind: "structure-item",
    subKind: "foreshadow",
    originSceneId: null,
    originCodexId: null,
    previewText: "伏線",
    previewMeta: null,
    payload: {
      originalId: "old-f1",
      projectId: "p1",
      title: "伏線",
      intent: "意図",
      notes: "メモ",
      payoffSceneRef: "scene-1",
      payoffFromPos: 2,
      payoffToPos: 8,
      payoffConfirmed: true,
      abandoned: true,
      secret: false,
      loadBearing: "critical",
      codexLinkDirtyAt: 1_784_000_000_000,
      ...overrides,
    },
    charCount: 2,
    isInteresting: true,
    deletedAt: "2026-07-28T00:00:00Z",
  };
}

function createdRow(id = "restored-foreshadow:trash-row-1"): ForeshadowRow {
  return {
    id,
    projectId: "p1",
    title: "伏線",
    intent: "意図",
    notes: "メモ",
    payoffSceneId: "scene-1",
    payoffFromPos: 2,
    payoffToPos: 8,
    payoffConfirmed: true,
    abandoned: true,
    secret: false,
    loadBearing: "critical",
    version: 0,
    codexLinkDirtyAt: new Date(1_784_000_000_000),
    createdAt: new Date(1_784_000_000_001),
    updatedAt: new Date(1_784_000_000_001),
  };
}

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(createdRow());
  getNodeMock.mockReset().mockResolvedValue({
    id: "scene-1",
    projectId: "p1",
  } as Awaited<ReturnType<typeof getNode>>);
});

describe("restoreForeshadow", () => {
  it("restores the full row in one durable create with a retry-stable identity", async () => {
    const source = item();

    await expect(
      restoreForeshadow(source, { projectId: "p1" }),
    ).resolves.toEqual({
      ok: true,
      newId: "restored-foreshadow:trash-row-1",
      brokenLinks: ["setups"],
    });
    await restoreForeshadow(source, { projectId: "p1" });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]).toEqual(createMock.mock.calls[1]);
    expect(createMock).toHaveBeenCalledWith(
      {
        id: "restored-foreshadow:trash-row-1",
        projectId: "p1",
        title: "伏線",
        intent: "意図",
        notes: "メモ",
        payoffSceneId: "scene-1",
        payoffFromPos: 2,
        payoffToPos: 8,
        payoffConfirmed: true,
        abandoned: true,
        secret: false,
        loadBearing: "critical",
        codexLinkDirtyAt: new Date(1_784_000_000_000),
      },
      { origin: "restore" },
    );
  });

  it("drops a cross-project payoff anchor before the atomic create", async () => {
    getNodeMock.mockResolvedValueOnce({
      id: "scene-1",
      projectId: "p2",
    } as Awaited<ReturnType<typeof getNode>>);

    await expect(
      restoreForeshadow(item(), { projectId: "p1" }),
    ).resolves.toEqual({
      ok: true,
      newId: "restored-foreshadow:trash-row-1",
      brokenLinks: ["payoffScene", "setups"],
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
      }),
      { origin: "restore" },
    );
  });

  it("defaults legacy snapshots to secret and no dirty timestamp", async () => {
    const legacy = item({ secret: undefined, codexLinkDirtyAt: undefined });

    await restoreForeshadow(legacy, { projectId: "p1" });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: true,
        codexLinkDirtyAt: null,
      }),
      { origin: "restore" },
    );
  });
});
