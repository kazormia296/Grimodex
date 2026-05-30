// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbInsertMock, dbSelectMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    insert: dbInsertMock,
    select: dbSelectMock,
  },
}));

import {
  _resetRecorderForTests,
  flushNow,
  initRecorderForProject,
  recordChangeEvent,
  resetRecorderChain,
  setRecorderEnabled,
} from "./recorder";
import { verifyChain, type EventForVerify } from "./hashChain";

interface InsertedRow {
  projectId: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  prevHash: string; // hex
  hash: string; // hex
}

function setupDb(initialTail: { sequence: number; hash: string } | null) {
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(initialTail ? [initialTail] : []),
        }),
      }),
    }),
  }));
  const inserted: InsertedRow[] = [];
  dbInsertMock.mockImplementation(() => ({
    values: (rows: InsertedRow[]) => {
      inserted.push(...rows);
      return Promise.resolve();
    },
  }));
  return inserted;
}

describe("recorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRecorderForTests();
    setRecorderEnabled(true);
  });

  it("flushes queued events with monotone sequence and chain continuity", async () => {
    const rows = setupDb(null);
    await initRecorderForProject("p1");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    recordChangeEvent({ domain: "codex", opType: "update", payload: { x: 0 } });
    await flushNow();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);

    // Each row's prevHash (hex) equals the previous row's hash.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].prevHash).toBe(rows[i - 1].hash);
    }

    // verifyChain accepts the produced chain.
    const asEvents: EventForVerify[] = rows.map((r) => ({
      projectId: r.projectId,
      sceneId: r.sceneId,
      domain: r.domain,
      opType: r.opType,
      entityType: r.entityType,
      entityId: r.entityId,
      payload: r.payload,
      sessionId: r.sessionId,
      sequence: r.sequence,
      timestamp: r.timestamp,
      prevHash: r.prevHash,
      hash: r.hash,
    }));
    expect((await verifyChain(asEvents)).ok).toBe(true);
  });

  it("resumes from the project tail when initializing", async () => {
    // Pretend the project already has a hash at sequence 42 (hex TEXT).
    const tailHex = "7c".repeat(32);
    const rows = setupDb({ sequence: 42, hash: tailHex });
    await initRecorderForProject("p2");
    recordChangeEvent({
      domain: "snippet",
      opType: "create",
      payload: { id: "x" },
    });
    await flushNow();

    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(43);
    expect(rows[0].prevHash).toBe(tailHex);
  });

  it("is a no-op when disabled", async () => {
    const rows = setupDb(null);
    await initRecorderForProject("p3");
    setRecorderEnabled(false);
    recordChangeEvent({ domain: "editor", opType: "step", payload: {} });
    await flushNow();
    expect(rows).toEqual([]);
  });

  it("drops events when no project is bound", async () => {
    const rows = setupDb(null);
    setRecorderEnabled(true);
    recordChangeEvent({ domain: "editor", opType: "step", payload: {} });
    await flushNow();
    expect(rows).toEqual([]);
  });

  it("resetRecorderChain restarts at genesis on same-project re-enable", async () => {
    // Bind to a project that already has a non-zero chain head (seq 42, hex).
    let tail: { sequence: number; hash: string } | null = {
      sequence: 42,
      hash: "7c".repeat(32),
    };
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(tail ? [tail] : []),
          }),
        }),
      }),
    }));
    const inserted: InsertedRow[] = [];
    dbInsertMock.mockImplementation(() => ({
      values: (rows: InsertedRow[]) => {
        inserted.push(...rows);
        return Promise.resolve();
      },
    }));

    await initRecorderForProject("p");

    // Simulate OFF -> ON: history wiped (tail now empty) + production reset.
    // Without resetRecorderChain, initRecorderForProject's idempotency guard
    // short-circuits and the next flush would write seq 43 / prevHash=old-head.
    tail = null;
    resetRecorderChain();
    await initRecorderForProject("p");

    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    await flushNow();

    expect(inserted).toHaveLength(2);
    expect(inserted[0].sequence).toBe(1);
    expect(inserted[0].prevHash).toBe("0".repeat(64)); // GENESIS (32 zero bytes)
    expect(inserted[1].prevHash).toBe(inserted[0].hash);
  });

  it("canonicalises top-level payload keys for stable hashing", async () => {
    const rows = setupDb(null);
    await initRecorderForProject("p4");
    recordChangeEvent({
      domain: "editor",
      opType: "step",
      payload: { b: 2, a: 1 },
    });
    await flushNow();
    expect(rows[0].payload).toBe('{"a":1,"b":2}');
  });

  it("discards queued events when disabled before flush (M1: flushNow enabled guard)", async () => {
    const rows = setupDb(null);
    await initRecorderForProject("p-off");
    // Queue an event while still enabled.
    recordChangeEvent({ domain: "editor", opType: "step", payload: {} });
    // Disable the recorder (simulating a switch to an OFF project).
    setRecorderEnabled(false);
    // An explicit flush must not write the stale events to the OFF project.
    await flushNow();
    expect(rows).toEqual([]);
  });

  it('serialises undefined payload as "null" for stable hashing (L2)', async () => {
    const rows = setupDb(null);
    await initRecorderForProject("p-undef");
    // undefined is a valid `unknown` payload; JSON.stringify(undefined) returns
    // undefined (not a string), so the canonicaliser must coerce it to "null".
    recordChangeEvent({ domain: "editor", opType: "step", payload: undefined });
    await flushNow();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBe("null");
  });

  it("re-queues events after flush failure so the retry succeeds (L1)", async () => {
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }));
    let insertCount = 0;
    const rows: InsertedRow[] = [];
    dbInsertMock.mockImplementation(() => ({
      values: (batch: InsertedRow[]) => {
        insertCount++;
        if (insertCount === 1) return Promise.reject(new Error("write failed"));
        rows.push(...batch);
        return Promise.resolve();
      },
    }));

    await initRecorderForProject("p-retry");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });

    // First flush fails; error must propagate to caller.
    await expect(flushNow()).rejects.toThrow("write failed");

    // Events must be re-queued by the catch block. The scheduleFlush() call in
    // that same catch block is what arms the timer so the retry fires without
    // a new event being recorded. Here we exercise the same code path the timer
    // would take: a naked flushNow() with no new event must commit the batch.
    await flushNow();

    expect(insertCount).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].opType).toBe("step");
  });
});
