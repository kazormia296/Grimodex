// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, dbSelectMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
}));

vi.mock("@/db/client", () => ({
  db: {
    select: dbSelectMock,
  },
}));

import {
  _resetRecorderForTests,
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
  flushNow,
  flushStrict,
  getRecorderChainHead,
  getRecorderSessionId,
  initRecorderForProject,
  recordChangeEvent,
  resetRecorderChain,
  setRecorderEnabled,
} from "./recorder";
import { debugLog } from "@/lib/debugLog";
import { collectQuiescenceProviderRecovery } from "@/lib/quiescenceProviders";
import {
  bytesToHex,
  computeEventHash,
  GENESIS_HASH,
  hexToBytes,
  verifyChain,
  type EventForVerify,
} from "./hashChain";

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

interface AppendResult {
  insertedCount: number;
  tailSequence: number;
  tailHash: string;
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

interface TailState {
  value: { sequence: number; hash: string } | null;
}

function setupTail(tail: TailState): void {
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(tail.value ? [tail.value] : []),
        }),
      }),
    }),
  }));
}

async function appendLikeRust(
  args: AppendArgs,
  rows: InsertedRow[],
  tail: TailState,
): Promise<AppendResult> {
  const uidPresent = (uid: string) =>
    rows.some((r) => r.projectId === args.projectId && r.eventUid === uid);
  const firstUid = args.events[0]?.eventUid;
  const firstPresent = firstUid ? uidPresent(firstUid) : false;

  let sequence = tail.value?.sequence ?? 0;
  let prevHash = tail.value?.hash ?? bytesToHex(GENESIS_HASH);
  let insertedCount = 0;
  for (const ev of args.events) {
    if (firstPresent && uidPresent(ev.eventUid)) continue;
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
    insertedCount += 1;
  }
  tail.value = { sequence, hash: prevHash };
  return {
    insertedCount,
    tailSequence: sequence,
    tailHash: prevHash,
  };
}

function setupAppendCommand(
  initialTail: { sequence: number; hash: string } | null = null,
): { rows: InsertedRow[]; tail: TailState } {
  const tail: TailState = { value: initialTail };
  setupTail(tail);
  const rows: InsertedRow[] = [];
  invokeMock.mockImplementation((cmd: string, args: AppendArgs) => {
    expect(cmd).toBe("timelapse_append_batch");
    return appendLikeRust(args, rows, tail);
  });
  return { rows, tail };
}

function toVerifyEvents(rows: InsertedRow[]): EventForVerify[] {
  return rows.map((r) => ({
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
}

describe("recorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRecorderForTests();
    setRecorderEnabled(true);
  });

  it("flushes queued events through the Rust allocator command", async () => {
    const { rows } = setupAppendCommand();
    await initRecorderForProject("p1");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    recordChangeEvent({ domain: "codex", opType: "update", payload: { x: 0 } });
    await flushNow();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [, args] = invokeMock.mock.calls[0] as [string, AppendArgs];
    expect(args.projectId).toBe("p1");
    expect(args.events).toHaveLength(3);
    expect(args.events[0].eventUid).toEqual(expect.any(String));
    expect(args.events[0]).not.toHaveProperty("sequence");
    expect(args.events[0]).not.toHaveProperty("hash");

    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
    expect((await verifyChain(toVerifyEvents(rows))).ok).toBe(true);
    expect(getRecorderChainHead()).toBe(3);
  });

  it("resumes from the project tail when initializing", async () => {
    const tailHex = "7c".repeat(32);
    const { rows } = setupAppendCommand({ sequence: 42, hash: tailHex });
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
    expect(getRecorderChainHead()).toBe(43);
  });

  it("is a no-op when disabled", async () => {
    setupAppendCommand();
    await initRecorderForProject("p3");
    setRecorderEnabled(false);
    recordChangeEvent({ domain: "editor", opType: "step", payload: {} });
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("drops events when no project is bound", async () => {
    setupAppendCommand();
    setRecorderEnabled(true);
    recordChangeEvent({ domain: "editor", opType: "step", payload: {} });
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("drops an explicitly scoped event for a different project", async () => {
    const { rows } = setupAppendCommand();
    await initRecorderForProject("active-project");
    recordChangeEvent({
      domain: "event",
      opType: "event.create",
      projectId: "staging-project",
      payload: { eventId: "staged-event" },
    });
    recordChangeEvent({
      domain: "event",
      opType: "event.create",
      projectId: "active-project",
      payload: { eventId: "active-event" },
    });
    await flushNow();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toContain("active-event");
  });

  it("resetRecorderChain lets the next append restart from genesis", async () => {
    const { rows, tail } = setupAppendCommand({
      sequence: 42,
      hash: "7c".repeat(32),
    });
    await initRecorderForProject("p");

    tail.value = null;
    resetRecorderChain();
    await initRecorderForProject("p");

    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    await flushNow();

    expect(rows).toHaveLength(2);
    expect(rows[0].sequence).toBe(1);
    expect(rows[0].prevHash).toBe("0".repeat(64));
    expect(rows[1].prevHash).toBe(rows[0].hash);
  });

  it("canonicalises top-level payload keys before sending the batch", async () => {
    const { rows } = setupAppendCommand();
    await initRecorderForProject("p4");
    recordChangeEvent({
      domain: "editor",
      opType: "step",
      payload: { b: 2, a: 1 },
    });
    await flushNow();
    expect(rows[0].payload).toBe('{"a":1,"b":2}');
  });

  it("discards queued events when disabled before flush", async () => {
    setupAppendCommand();
    await initRecorderForProject("p-off");
    recordChangeEvent({ domain: "editor", opType: "step", payload: {} });
    setRecorderEnabled(false);
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('serialises undefined payload as "null"', async () => {
    const { rows } = setupAppendCommand();
    await initRecorderForProject("p-undef");
    recordChangeEvent({ domain: "editor", opType: "step", payload: undefined });
    await flushNow();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBe("null");
  });

  it("re-queues events after a transient command failure", async () => {
    const tail: TailState = { value: null };
    setupTail(tail);
    const rows: InsertedRow[] = [];
    let calls = 0;
    invokeMock.mockImplementation((cmd: string, args: AppendArgs) => {
      expect(cmd).toBe("timelapse_append_batch");
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("write failed"));
      return appendLikeRust(args, rows, tail);
    });

    await initRecorderForProject("p-retry");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });

    await expect(flushNow()).rejects.toThrow("write failed");
    expect(collectQuiescenceProviderRecovery()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "timelapse-event",
          projectId: "p-retry",
          domain: "editor",
          opType: "step",
          payload: { i: 1 },
        }),
      ]),
    );
    await flushNow();

    expect(calls).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].opType).toBe("step");
  });

  it("dedupes a resent batch when the first command committed but rejected", async () => {
    const tail: TailState = { value: null };
    setupTail(tail);
    const rows: InsertedRow[] = [];
    let first = true;
    invokeMock.mockImplementation(async (cmd: string, args: AppendArgs) => {
      expect(cmd).toBe("timelapse_append_batch");
      const result = await appendLikeRust(args, rows, tail);
      if (first) {
        first = false;
        throw new Error("transport lost after commit");
      }
      return result;
    });

    await initRecorderForProject("p-idem");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });

    await expect(flushNow()).rejects.toThrow("transport lost after commit");
    await flushNow();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(getRecorderChainHead()).toBe(1);
  });

  it("keeps new events that arrive during a committed-but-rejected flush", async () => {
    const tail: TailState = { value: null };
    setupTail(tail);
    const rows: InsertedRow[] = [];
    let calls = 0;
    invokeMock.mockImplementation(async (cmd: string, args: AppendArgs) => {
      expect(cmd).toBe("timelapse_append_batch");
      calls += 1;
      const result = await appendLikeRust(args, rows, tail);
      if (calls === 1) {
        // Commit landed, but the transport rejects the response.
        throw new Error("transport lost after commit");
      }
      return result;
    });

    await initRecorderForProject("p-merge");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    await expect(flushNow()).rejects.toThrow("transport lost after commit");

    // A new event is queued after the committed-but-rejected flush; the retry
    // batch is [event1 (already committed), event2 (new)]. event2 must NOT be
    // dropped by the first-uid dedupe.
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    await flushNow();

    expect(rows.map((r) => JSON.parse(r.payload).i)).toEqual([1, 2]);
    expect(rows).toHaveLength(2);
    expect((await verifyChain(toVerifyEvents(rows))).ok).toBe(true);
    expect(getRecorderChainHead()).toBe(2);
  });

  it("pauses automatic retry without dropping the batch after repeated failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setupTail({ value: null });
      let calls = 0;
      invokeMock.mockImplementation(() => {
        calls += 1;
        return Promise.reject(new Error("boom"));
      });

      await initRecorderForProject("p-cap");
      recordChangeEvent({
        domain: "editor",
        opType: "step",
        payload: { i: 1 },
      });

      for (let i = 0; i < 10; i += 1) {
        await expect(flushNow()).rejects.toThrow("boom");
      }
      await expect(flushNow()).rejects.toThrow("boom");
      expect(calls).toBe(11);

      invokeMock.mockResolvedValue({ tailSequence: 1, inserted: 1 });
      await flushNow();
      expect(invokeMock).toHaveBeenCalledTimes(12);
      expect(warn).toHaveBeenCalledWith(
        "[timelapse] pausing automatic retry for 1 event(s) after 10 failed flush attempts",
      );
    } finally {
      warn.mockRestore();
    }
  });

  // --- workspace 切替の状態機械 (M3 review r5) ---
  // recording可 ⟺ bound ∧ ¬bindingInvalidated ∧ ¬switchInProgress。
  // 束縛を有効化する唯一の経路は initRecorderForProject。

  it("切替開始で既存キューを破棄し、切替中はイベント破棄・flush no-op", async () => {
    setupAppendCommand();
    await initRecorderForProject("p-sus");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });

    beginWorkspaceSwitch();
    // 切替中に発生したイベントは破棄される
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("WORKSPACE_SWITCHING 拒否のバッチは re-queue しない (open 完了後の混入防止)", async () => {
    setupTail({ value: null });
    invokeMock.mockImplementation(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "workspace is switching; DB access is temporarily rejected",
          ),
          { code: "WORKSPACE_SWITCHING" },
        ),
      ),
    );
    await initRecorderForProject("p-marker");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });

    // 通常の失敗と違い throw せず、バッチを破棄して静かに終わる
    await expect(flushNow()).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // 破棄済みなので再 flush で再送されない
    await flushNow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("strict flush は WORKSPACE_SWITCHING batch を保持して lifecycle を拒否する", async () => {
    setupTail({ value: null });
    invokeMock
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            "workspace is switching; DB access is temporarily rejected",
          ),
          { code: "WORKSPACE_SWITCHING" },
        ),
      )
      .mockResolvedValueOnce({ tailSequence: 1 });
    await initRecorderForProject("p-strict-marker");
    recordChangeEvent({
      domain: "editor",
      opType: "step",
      payload: { i: 1 },
    });

    await expect(flushStrict()).rejects.toMatchObject({
      code: "WORKSPACE_SWITCHING",
    });
    expect(
      collectQuiescenceProviderRecovery().filter(
        (item) => (item as { kind?: unknown }).kind === "timelapse-event",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "timelapse-event",
        projectId: "p-strict-marker",
        domain: "editor",
        opType: "step",
        payload: { i: 1 },
      }),
    ]);

    await flushStrict();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(
      collectQuiescenceProviderRecovery().filter(
        (item) => (item as { kind?: unknown }).kind === "timelapse-event",
      ),
    ).toEqual([]);
  });

  it("strict flush は実行中の automatic flush も lossless policy に昇格する", async () => {
    setupTail({ value: null });
    let rejectWrite!: (reason?: unknown) => void;
    const inFlightWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    invokeMock
      .mockReturnValueOnce(inFlightWrite)
      .mockResolvedValueOnce({ tailSequence: 1 });
    await initRecorderForProject("p-strict-inflight");
    recordChangeEvent({
      domain: "editor",
      opType: "step",
      payload: { i: 1 },
    });

    const automaticFlush = flushNow();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());
    const strictFlush = flushStrict();
    const switchingError = Object.assign(
      new Error("workspace is switching; DB access is temporarily rejected"),
      { code: "WORKSPACE_SWITCHING" },
    );
    const automaticFailure =
      expect(automaticFlush).rejects.toBe(switchingError);
    const strictFailure = expect(strictFlush).rejects.toBe(switchingError);
    rejectWrite(switchingError);

    await automaticFailure;
    await strictFailure;
    expect(
      collectQuiescenceProviderRecovery().filter(
        (item) => (item as { kind?: unknown }).kind === "timelapse-event",
      ),
    ).toEqual([
      expect.objectContaining({
        projectId: "p-strict-inflight",
        payload: { i: 1 },
      }),
    ]);

    await flushStrict();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("契約(a): 切替成功後は init 完了まで recordChangeEvent が warn 付きで破棄される", async () => {
    const warnSpy = vi.spyOn(debugLog, "warn");
    const { rows } = setupAppendCommand();
    await initRecorderForProject("p-old");

    beginWorkspaceSwitch();
    endWorkspaceSwitch(); // 切替成功: restoreBinding なし = 束縛は無効のまま

    // rebind 前のイベントは破棄され、初回は warn が出る
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(
        ([tag, msg]) => tag === "timelapse" && String(msg).includes("破棄中"),
      ),
    ).toBe(true);

    // 正規 rebind (init) の完了で記録が再開する
    await initRecorderForProject("p-new");
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    await flushNow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [, args] = invokeMock.mock.calls[0] as [string, AppendArgs];
    expect(args.projectId).toBe("p-new");
    expect(args.events).toHaveLength(1);
    expect(rows.every((r) => r.projectId === "p-new")).toBe(true);
    warnSpy.mockRestore();
  });

  it("契約(b): 切替失敗 (restoreBinding) では旧束縛のまま記録が継続する", async () => {
    const { rows } = setupAppendCommand();
    await initRecorderForProject("p-old");

    beginWorkspaceSwitch();
    endWorkspaceSwitch({ restoreBinding: true }); // swap 未実行の失敗

    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    await flushNow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [, args] = invokeMock.mock.calls[0] as [string, AppendArgs];
    expect(args.projectId).toBe("p-old");
    expect(rows.every((r) => r.projectId === "p-old")).toBe(true);
  });

  it("契約(c): 切替中に完了した bystander init は束縛を書かない", async () => {
    setupAppendCommand();
    await initRecorderForProject("p-old");

    beginWorkspaceSwitch();
    const bound = await initRecorderForProject("p-bystander");
    expect(bound).toBe(false);

    endWorkspaceSwitch(); // 切替成功 (rebind 待ち)
    // bystander init は束縛を書いていないので記録は再開しない
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();

    // 正規 rebind で再開する
    const rebound = await initRecorderForProject("p-new");
    expect(rebound).toBe(true);
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 2 } });
    await flushNow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("契約(d): 完了時に世代が進んでいた旧 init は state を書かない (Minor-2)", async () => {
    // tail read を遅延させて init を切替と交差させる
    let releaseTail!: (v: Array<{ sequence: number }>) => void;
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () =>
              new Promise<Array<{ sequence: number }>>((r) => {
                releaseTail = r;
              }),
          }),
        }),
      }),
    }));

    const initP = initRecorderForProject("p-slow"); // 旧 init (tail 未解決)
    beginWorkspaceSwitch(); // 世代が進む
    endWorkspaceSwitch();
    releaseTail([{ sequence: 42 }]); // 旧 init が遅延 resolve

    const bound = await initP;
    expect(bound).toBe(false); // 束縛を書かない
    expect(getRecorderChainHead()).toBe(0); // lastSequence を clobber しない

    // 記録も再開していない (束縛は無効のまま)
    recordChangeEvent({ domain: "editor", opType: "step", payload: { i: 1 } });
    await flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("workspace 切替を跨いだら同一 projectId でも再 init する (R4-3)", async () => {
    // 旧 workspace: tail = 42
    setupAppendCommand({ sequence: 42, hash: "7c".repeat(32) });
    await initRecorderForProject("default-project");
    expect(getRecorderChainHead()).toBe(42);
    const oldSession = getRecorderSessionId();

    // workspace 切替 (begin → swap 成功 → end)。新 workspace の chain は空。
    // 両 workspace とも projectId は 'default-project' (最頻ケース)。
    beginWorkspaceSwitch();
    endWorkspaceSwitch();
    setupTail({ value: null });
    const bound = await initRecorderForProject("default-project");
    expect(bound).toBe(true);

    // projectId だけの冪等ガードだと旧 initPromise を返して no-op になり、
    // 旧 tail(42) が新 workspace の seed snapshot に焼かれてしまう。
    expect(getRecorderChainHead()).toBe(0);
    expect(getRecorderSessionId()).not.toBe(oldSession);
  });
});
