// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbInsertMock, dbSelectMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { insert: dbInsertMock, select: dbSelectMock },
}));

import {
  loadLatestSnapshot,
  recordStateSnapshot,
  shouldCreateSnapshot,
} from "./snapshots";

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
