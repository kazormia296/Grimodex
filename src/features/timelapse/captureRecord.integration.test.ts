// @vitest-environment happy-dom
//
// 統合テスト: capture アダプタ(captureChat/captureLayout) → 実 recorder(enabled)
// → flush → timelapse_append_batch の経路を end-to-end で検証する。

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, dbSelectMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
}));

vi.mock("@/db/client", () => ({
  db: { select: dbSelectMock },
}));

import {
  _resetRecorderForTests,
  flushNow,
  initRecorderForProject,
  setRecorderEnabled,
} from "./recorder";
import { recordChatMessageAdd, recordChatMessageDelete } from "./captureChat";
import { recordLayoutSnapshot } from "./captureLayout";
import {
  bytesToHex,
  computeEventHash,
  GENESIS_HASH,
  hexToBytes,
  verifyChain,
  type EventForVerify,
} from "./hashChain";
import type { LayoutState } from "@/features/layout/layoutTypes";

interface CommandEvent {
  eventUid: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  timestamp: number;
}

interface AppendArgs {
  projectId: string;
  sessionId: string;
  events: CommandEvent[];
}

interface InsertedRow {
  eventUid: string;
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
  prevHash: string;
  hash: string;
}

function setupCommand(): InsertedRow[] {
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }));

  const rows: InsertedRow[] = [];
  let sequence = 0;
  let prevHash = bytesToHex(GENESIS_HASH);
  invokeMock.mockImplementation(async (cmd: string, args: AppendArgs) => {
    expect(cmd).toBe("timelapse_append_batch");
    for (const ev of args.events) {
      sequence += 1;
      const hash = bytesToHex(
        await computeEventHash({
          projectId: args.projectId,
          sceneId: ev.sceneId,
          domain: ev.domain,
          opType: ev.opType,
          entityType: ev.entityType,
          entityId: ev.entityId,
          payload: ev.payload,
          sessionId: args.sessionId,
          sequence,
          timestamp: ev.timestamp,
          prevHash: hexToBytes(prevHash),
        }),
      );
      rows.push({
        eventUid: ev.eventUid,
        projectId: args.projectId,
        sceneId: ev.sceneId,
        domain: ev.domain,
        opType: ev.opType,
        entityType: ev.entityType,
        entityId: ev.entityId,
        payload: ev.payload,
        sessionId: args.sessionId,
        sequence,
        timestamp: ev.timestamp,
        prevHash,
        hash,
      });
      prevHash = hash;
    }
    return {
      insertedCount: args.events.length,
      tailSequence: sequence,
      tailHash: prevHash,
    };
  });
  return rows;
}

const LAYOUT: LayoutState = {
  regions: {
    left: { size: 280, slots: [] },
    right: { size: 0, slots: [] },
    bottom: { size: 0, slots: [] },
  },
  center: { editorOpen: true, segments: [] },
};

describe("timelapse capture → recorder → flush (enabled, real adapters)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRecorderForTests();
    setRecorderEnabled(true);
  });

  it("sends chat + layout events to the append command with TEXT payload and a valid chain", async () => {
    const rows = setupCommand();
    await initRecorderForProject("proj");

    recordChatMessageAdd({
      sessionId: "s",
      messageId: "m1",
      role: "user",
      text: "こんにちは",
      createdAt: "2026-05-30T00:00:00.000Z",
    });
    recordLayoutSnapshot({ layout: LAYOUT });
    recordChatMessageDelete({ messageId: "m1", sessionId: "s" });
    await flushNow();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [, args] = invokeMock.mock.calls[0] as [string, AppendArgs];
    expect(args.events.map((r) => r.domain)).toEqual([
      "chat",
      "layout",
      "chat",
    ]);
    expect(args.events.map((r) => r.opType)).toEqual([
      "chat.message.add",
      "layout.snapshot",
      "chat.message.delete",
    ]);
    expect(args.events.every((r) => typeof r.eventUid === "string")).toBe(true);
    expect(args.events[0]).not.toHaveProperty("sequence");
    expect(args.events[0]).not.toHaveProperty("hash");

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);

    for (const r of rows) {
      expect(r.sceneId).toBeNull();
      expect(typeof r.payload).toBe("string");
      expect(() => JSON.parse(r.payload)).not.toThrow();
    }

    const add = JSON.parse(rows[0].payload);
    expect(add.text).toBe("こんにちは");
    expect(add.role).toBe("user");
    expect(add.sessionId).toBe("s");

    const layout = JSON.parse(rows[1].payload);
    expect(layout.layout).toEqual(LAYOUT);

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
});
