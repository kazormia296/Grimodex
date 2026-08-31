// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbInsertMock, dbSelectMock, invokeMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
  invokeMock: vi.fn(
    (_command: string, _args?: Record<string, unknown>): Promise<unknown> =>
      Promise.resolve({ rows: [] }),
  ),
}));

vi.mock("@/db/client", () => ({
  db: { insert: dbInsertMock, select: dbSelectMock },
}));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  appendGenesisBaselines,
  loadLatestSnapshot,
  recordStateSnapshot,
  shouldCreateSnapshot,
} from "./snapshots";

interface GenesisInvokeArgs extends Record<string, unknown> {
  expectedWorkspacePath: string;
  projectId: string;
  kind: "scene" | "codex" | "snippet";
  entityIds: string[];
  anchorTimestamp: number;
}

function isGenesisInvokeArgs(
  args: Record<string, unknown>,
): args is GenesisInvokeArgs {
  return (
    typeof args.expectedWorkspacePath === "string" &&
    typeof args.projectId === "string" &&
    (args.kind === "scene" ||
      args.kind === "codex" ||
      args.kind === "snippet") &&
    Array.isArray(args.entityIds) &&
    args.entityIds.every((entityId) => typeof entityId === "string") &&
    typeof args.anchorTimestamp === "number"
  );
}

function genesisInvokeCall(index: number): {
  command: string;
  args: GenesisInvokeArgs;
} {
  const call = invokeMock.mock.calls[index];
  if (!call) throw new Error(`missing invoke call ${index}`);
  const [command, args] = call;
  if (!args || !isGenesisInvokeArgs(args)) {
    throw new Error(`invoke call ${index} has invalid genesis args`);
  }
  return { command, args };
}

describe("shouldCreateSnapshot", () => {
  it("returns true once the event gap is exceeded", () => {
    expect(
      shouldCreateSnapshot({
        eventsSinceLast: 1000,
        timeSinceLastMs: 0,
      }),
    ).toBe(true);
  });

  it("returns true once the time gap is exceeded", () => {
    expect(
      shouldCreateSnapshot({
        eventsSinceLast: 0,
        timeSinceLastMs: 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("returns false when both gaps are still below threshold", () => {
    expect(
      shouldCreateSnapshot({
        eventsSinceLast: 50,
        timeSinceLastMs: 5_000,
      }),
    ).toBe(false);
  });

  it("respects custom thresholds", () => {
    expect(
      shouldCreateSnapshot({
        eventsSinceLast: 10,
        timeSinceLastMs: 0,
        eventGap: 5,
      }),
    ).toBe(true);
  });
});

describe("genesis snapshot batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue({
      insertedCount: 0,
      skippedExistingBaselineCount: 0,
      skippedExistingBodyStepCount: 0,
    });
  });

  it("dispatches 501 ids in eight typed, workspace-bound chunks", async () => {
    const entityIds = Array.from(
      { length: 501 },
      (_, index) => `scene-${index}`,
    );

    await appendGenesisBaselines({
      expectedWorkspacePath: "/workspace/novel.gdx",
      projectId: "p1",
      kind: "scene",
      entityIds,
      anchorTimestamp: 123,
    });

    expect(invokeMock).toHaveBeenCalledTimes(8);
    for (let index = 0; index < invokeMock.mock.calls.length; index += 1) {
      const { command, args } = genesisInvokeCall(index);
      expect(command).toBe("timelapse_genesis_baselines_append");
      expect(args).toEqual({
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        kind: "scene",
        entityIds: expect.any(Array),
        anchorTimestamp: 123,
      });
      expect(args.entityIds.length).toBeLessThanOrEqual(64);
    }
  });

  it("combines native per-entity idempotency summaries for resume visibility", async () => {
    invokeMock
      .mockResolvedValueOnce({
        insertedCount: 60,
        skippedExistingBaselineCount: 3,
        skippedExistingBodyStepCount: 1,
      })
      .mockResolvedValueOnce({
        insertedCount: 1,
        skippedExistingBaselineCount: 0,
        skippedExistingBodyStepCount: 0,
      });

    const result = await appendGenesisBaselines({
      expectedWorkspacePath: "/workspace/novel.gdx",
      projectId: "p1",
      kind: "codex",
      entityIds: Array.from({ length: 65 }, (_, index) => `codex-${index}`),
      anchorTimestamp: 456,
    });

    expect(result).toEqual({
      insertedCount: 61,
      skippedExistingBaselineCount: 3,
      skippedExistingBodyStepCount: 1,
      completed: true,
    });
  });

  it("recursively splits only the stable Native aggregate-size rejection", async () => {
    let first = true;
    invokeMock.mockImplementation(async (_command, args) => {
      if (!args || !Array.isArray(args.entityIds)) {
        throw new Error("missing genesis entityIds");
      }
      const ids = args.entityIds;
      if (first) {
        first = false;
        throw new Error("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE");
      }
      return {
        insertedCount: ids.length,
        skippedExistingBaselineCount: 0,
        skippedExistingBodyStepCount: 0,
      };
    });

    await expect(
      appendGenesisBaselines({
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        kind: "scene",
        entityIds: Array.from({ length: 64 }, (_, index) => `scene-${index}`),
        anchorTimestamp: 1,
      }),
    ).resolves.toEqual({
      insertedCount: 64,
      skippedExistingBaselineCount: 0,
      skippedExistingBodyStepCount: 0,
      completed: true,
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(genesisInvokeCall(1).args.entityIds).toHaveLength(32);
    expect(genesisInvokeCall(2).args.entityIds).toHaveLength(32);
  });

  it("checks authority again between aggregate-size split retries", async () => {
    let authoritative = true;
    let call = 0;
    invokeMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        throw new Error("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE");
      }
      authoritative = false;
      return {
        insertedCount: 32,
        skippedExistingBaselineCount: 0,
        skippedExistingBodyStepCount: 0,
      };
    });

    await appendGenesisBaselines(
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        kind: "scene",
        entityIds: Array.from({ length: 64 }, (_, index) => `scene-${index}`),
        anchorTimestamp: 1,
      },
      () => authoritative,
    );

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("stops before the next chunk when authority is lost", async () => {
    let authoritative = true;
    invokeMock.mockImplementation(async () => {
      authoritative = false;
      return { rows: [] };
    });
    await appendGenesisBaselines(
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        kind: "snippet",
        entityIds: Array.from(
          { length: 130 },
          (_, index) => `snippet-${index}`,
        ),
        anchorTimestamp: 789,
      },
      () => authoritative,
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("treats an authority-race rejection as silent cancellation", async () => {
    let authoritative = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockImplementation(async () => {
      authoritative = false;
      throw new Error("TIMELAPSE_GENESIS_WORKSPACE_CHANGED");
    });

    await expect(
      appendGenesisBaselines(
        {
          expectedWorkspacePath: "/workspace/old.gdx",
          projectId: "p1",
          kind: "scene",
          entityIds: ["scene-1"],
          anchorTimestamp: 1,
        },
        () => authoritative,
      ),
    ).resolves.toEqual({
      insertedCount: 0,
      skippedExistingBaselineCount: 0,
      skippedExistingBodyStepCount: 0,
      completed: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once and leaves remaining chunks for the next load on a live failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockRejectedValue(new Error("disk full"));

    await appendGenesisBaselines({
      expectedWorkspacePath: "/workspace/novel.gdx",
      projectId: "p1",
      kind: "scene",
      entityIds: Array.from({ length: 130 }, (_, index) => `scene-${index}`),
      anchorTimestamp: 1,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("recordStateSnapshot + loadLatestSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips a JSON payload as plain text", async () => {
    let stored: { payload: string; encoding: string } | null = null;
    dbInsertMock.mockImplementation(() => ({
      values: (row: { payload: string; encoding: string }) => {
        stored = { payload: row.payload, encoding: row.encoding };
        return Promise.resolve();
      },
    }));

    await recordStateSnapshot({
      projectId: "p1",
      domain: "editor",
      entityId: "scene-a",
      anchorSequence: 100,
      anchorTimestamp: 1_700_000_000_000,
      payload: { doc: { type: "doc", content: [] } },
    });
    expect(stored).not.toBeNull();
    expect((stored as unknown as { encoding: string }).encoding).toBe("json");
    // Stored as plain JSON TEXT (no compression / no Buffer).
    expect(typeof (stored as unknown as { payload: string }).payload).toBe(
      "string",
    );

    // Now make the SELECT chain return the row we just "stored" so the
    // decoder side of the test gets exercised.
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () =>
              Promise.resolve([
                {
                  projectId: "p1",
                  domain: "editor",
                  entityType: null,
                  entityId: "scene-a",
                  anchorSequence: 100,
                  anchorTimestamp: 1_700_000_000_000,
                  payload: (stored as unknown as { payload: string }).payload,
                  encoding: "json",
                  createdAt: 0,
                },
              ]),
          }),
        }),
      }),
    }));

    const decoded = await loadLatestSnapshot({
      projectId: "p1",
      domain: "editor",
      entityId: "scene-a",
    });
    expect(decoded).not.toBeNull();
    expect(decoded?.anchorSequence).toBe(100);
    expect(decoded?.payload).toEqual({ doc: { type: "doc", content: [] } });
  });

  it("returns null when no snapshot exists", async () => {
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    }));
    const decoded = await loadLatestSnapshot({
      projectId: "p1",
      domain: "editor",
    });
    expect(decoded).toBeNull();
  });
});
