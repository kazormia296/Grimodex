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
  prevHash: Buffer;
  hash: Buffer;
}

function setupDb(initialTail: { sequence: number; hash: Buffer } | null) {
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

    // Each row's prevHash equals the previous row's hash.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].prevHash.equals(rows[i - 1].hash)).toBe(true);
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
    // Pretend the project already has a hash at sequence 42.
    const tailHash = Buffer.alloc(32, 0x7c);
    const rows = setupDb({ sequence: 42, hash: tailHash });
    await initRecorderForProject("p2");
    recordChangeEvent({
      domain: "snippet",
      opType: "create",
      payload: { id: "x" },
    });
    await flushNow();

    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(43);
    expect(rows[0].prevHash.equals(tailHash)).toBe(true);
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
});
