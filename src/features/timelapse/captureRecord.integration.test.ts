// @vitest-environment happy-dom
//
// 統合テスト: capture アダプタ(captureChat/captureLayout) → 実 recorder(enabled)
// → flush → db.insert の経路を end-to-end で検証する。unit テストは recorder を
// vi.mock していたため「enabled で実際に行が落ちるか」「payload が TEXT 化されるか」
// 「混在ドメインで hashChain が valid か」は未検証だった。forward-only の記録は
// 壊れていても気付けず過去データが永久欠落するため(過去に commit 70687944 で
// change_events が一度も書かれない事故)、この経路を gate する。
//
// 注意: ここは JS の db モックで insert を捕捉するだけで、実 Tauri の Rust proxy
// (FK ON / drizzle TEXT round-trip) は検証しない。それは実機 smoke で確認する。
// ただし全 capture アダプタは sceneId:null なので FK は exercise されない。

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbInsertMock, dbSelectMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { insert: dbInsertMock, select: dbSelectMock },
}));

import {
  _resetRecorderForTests,
  flushNow,
  initRecorderForProject,
  setRecorderEnabled,
} from "./recorder";
import { recordChatMessageAdd, recordChatMessageDelete } from "./captureChat";
import { recordLayoutSnapshot } from "./captureLayout";
import { verifyChain, type EventForVerify } from "./hashChain";
import type { LayoutState } from "@/features/layout/layoutTypes";

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
  prevHash: string;
  hash: string;
}

function setupDb(): InsertedRow[] {
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
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

  it("persists chat + layout events end-to-end with TEXT payload and a valid chain", async () => {
    const rows = setupDb();
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

    // 3 行すべて落ちた (flush が throw して止まっていない)。
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.domain)).toEqual(["chat", "layout", "chat"]);
    expect(rows.map((r) => r.opType)).toEqual([
      "chat.message.add",
      "layout.snapshot",
      "chat.message.delete",
    ]);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);

    for (const r of rows) {
      // sceneId は必ず null (treeNodes FK 違反で flush 全停止する罠の回避)。
      expect(r.sceneId).toBeNull();
      // payload は drizzle 互換の JSON TEXT。
      expect(typeof r.payload).toBe("string");
      expect(() => JSON.parse(r.payload)).not.toThrow();
    }

    // chat.message.add は本文を inline 焼き込み (mutable な chat_messages を
    // 参照していないので削除されても replay 可能)。
    const add = JSON.parse(rows[0].payload);
    expect(add.text).toBe("こんにちは");
    expect(add.role).toBe("user");
    expect(add.sessionId).toBe("s");

    // layout.snapshot は full LayoutState を自己完結で保持。
    const layout = JSON.parse(rows[1].payload);
    expect(layout.layout).toEqual(LAYOUT);

    // 混在ドメインでも hashChain は連続・valid。
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
