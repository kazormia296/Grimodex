// @vitest-environment happy-dom
//
// EAR-1 の中核（起案 T-1・T-3 (j)(t)）。実 recorder・実 genesisBarrier・実
// runTimelapseEditorBodyWrite と、採番器を共有する Native の fake で、
// 「最新 snapshot ＋ seq > anchor の step を再生した doc が editor の最終 doc と一致する」
// ことを、窓の中のあらゆる時点で打った step について確かめる。
// 現行の再現の試験（recorder が未 bind）ではこの種のずれは見えない。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  _inspectOwnSaveCapturesForTests,
  _resetRecorderForTests,
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
  flushStrict,
  initRecorderForProject as initRecorderForProjectImpl,
  recordChangeEvent,
  setRecorderEnabled,
} from "./recorder";
import {
  _resetTimelapseBodyWriteTailsForTests,
  runTimelapseEditorBodyWrite,
} from "./bodyWriteMode";
import { buildReplayStart } from "./replayStart";
import { replayEditorSteps, type ReplayEvent } from "./replayEngine";
import type { TimelapseDocumentIdentity } from "./documentCoverage";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const P = "p-t1";
const ID: TimelapseDocumentIdentity = {
  projectId: P,
  domain: "editor",
  entityType: "scene",
  entityId: "scene-1",
  storage: "database",
};
const schema = getSchema([StarterKit]);

async function initRecorderForProject(projectId: string): Promise<boolean> {
  publishCurrentProjectId(projectId);
  setCurrentWorkspaceIdentity({
    path: "/workspace/own-save-t1.gdx",
    openRevision: 1,
  });
  return initRecorderForProjectImpl(projectId);
}

interface StoredEvent {
  sequence: number;
  domain: string;
  opType: string;
  payload: string;
}

interface Native {
  /** doc.step と bundle の snapshot が同じ採番器で anchor を置く。 */
  seq: number;
  events: StoredEvent[];
  snapshots: Array<{ anchorSequence: number; payload: unknown }>;
  onAppend: (() => void) | null;
  failNextAppend: boolean;
}

let native: Native;
let editor: EditorState;

function createEditor(text: string): void {
  editor = EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, text ? [schema.text(text)] : []),
    ]),
  });
  // 保存前から Native にある seed（anchor 0）。commit が失敗する分岐の再生元。
  native.snapshots.push({
    anchorSequence: 0,
    payload: editor.doc.toJSON(),
  });
}

/** editor に 1 文字打ち、pipeline と同じ形で recorder に doc.step を渡す。 */
function type(text: string): void {
  const tr = editor.tr.insertText(text, editor.doc.content.size - 1);
  editor = editor.apply(tr);
  recordChangeEvent({
    domain: "editor",
    opType: "doc.step",
    projectId: P,
    entityType: "scene",
    entityId: "scene-1",
    payload: { steps: tr.steps.map((s) => s.toJSON()) },
  });
}

/** 最新 snapshot ＋ seq > anchor の step の再生が、editor の最終 doc と一致するか。 */
function replayedDoc(): ProseMirrorNode {
  const latest = native.snapshots[native.snapshots.length - 1];
  const events: ReplayEvent[] = native.events
    .filter((e) => e.domain === "editor" && e.opType === "doc.step")
    .map((e) => ({
      domain: "editor",
      opType: "doc.step",
      payload: e.payload,
      sequence: e.sequence,
    })) as ReplayEvent[];
  const start = buildReplayStart(schema, events, latest);
  const result = replayEditorSteps(
    schema,
    start.initialDoc,
    start.replayEvents,
  );
  expect(result.failedAt).toBeUndefined();
  return result.doc;
}

function expectReplayMatchesEditor(): void {
  expect(replayedDoc().toJSON()).toEqual(editor.doc.toJSON());
}

const tick = () => Promise.resolve();

interface SavePlan {
  /** runTimelapseEditorBodyWrite を呼んだ直後（同期）。flushStrict の前。 */
  beforeFlush?: () => void;
  /** commit callback の最初の同期行（flushStrict の後で bundle の前）。 */
  atCommitStart?: () => void;
  /** bundle の IPC の途中で、Native の tx の前。 */
  beforeTx?: () => void;
  /** Native の tx の後で、応答が返る前。 */
  afterTx?: () => void;
  /** release の後の renderer projection の最中。 */
  inProject?: () => void;
  /** beforeTx の後、tx の前に待つ gate。窓を開けたまま時間を進める試験用。 */
  gate?: Promise<void>;
  failCommit?: boolean;
}

/** T0 の doc は呼び出しの同期区間で捕捉する（persistSceneBody と同じ）。 */
function startSave(plan: SavePlan = {}): Promise<void> {
  const t0 = editor.doc;
  const done = runTimelapseEditorBodyWrite<string, void>(
    { projectId: P, documentIdentity: ID },
    {
      commit: async () => {
        plan.atCommitStart?.();
        await tick();
        plan.beforeTx?.();
        await tick();
        await plan.gate;
        if (plan.failCommit) throw new Error("bundle failed");
        native.snapshots.push({
          anchorSequence: native.seq,
          payload: t0.toJSON(),
        });
        plan.afterTx?.();
        await tick();
        return "ok";
      },
      project: async () => {
        plan.inProject?.();
      },
    },
  );
  plan.beforeFlush?.();
  return done;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRecorderForTests();
  _resetQuiescenceLeasesForTests();
  _resetTimelapseBodyWriteTailsForTests();
  setRecorderEnabled(true);
  publishCurrentProjectId(null);
  setCurrentWorkspaceIdentity(null);

  native = {
    seq: 0,
    events: [],
    snapshots: [],
    onAppend: null,
    failNextAppend: false,
  };
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  }));
  invokeMock.mockImplementation(
    async (
      cmd: string,
      args: {
        events: Array<{ domain: string; opType: string; payload: string }>;
      },
    ) => {
      expect(cmd).toBe("timelapse_append_batch");
      native.onAppend?.();
      if (native.failNextAppend) {
        native.failNextAppend = false;
        throw new Error("append failed");
      }
      for (const event of args.events) {
        native.seq += 1;
        native.events.push({
          sequence: native.seq,
          domain: event.domain,
          opType: event.opType,
          payload: event.payload,
        });
      }
      return { tailSequence: native.seq };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * tx の前に gate で窓を開けたまま、debounce（100ms）を十分に超えて時間を進める。
 * 預からずに queue へ直行した step がいれば、この間の flush timer が tx より先に
 * Native へ流し、「seq は anchor より前なのに T0 の snapshot に無い step」になる。
 */
async function saveHoldingWindowOpen(plan: SavePlan = {}): Promise<void> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = startSave({ ...plan, gate });
  await vi.advanceTimersByTimeAsync(1000);
  open();
  return done;
}

describe("T-1 自分の保存の窓内の step は anchor の後に並ぶ", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await initRecorderForProject(P);
    createEditor("start");
    // T0 より前の step（まだ flush されていない）。
    type("-a");
  });

  const points: Array<[string, (type: () => void) => SavePlan]> = [
    ["(a) flushStrict の前", (t) => ({ beforeFlush: t })],
    ["(c) flushStrict の後で bundle の前", (t) => ({ atCommitStart: t })],
    ["(d) bundle の IPC の間（tx の前）", (t) => ({ beforeTx: t })],
    ["(d) bundle の IPC の間（tx の後で応答の前）", (t) => ({ afterTx: t })],
    ["(e) 応答の後（projection の最中）", (t) => ({ inProject: t })],
  ];

  it.each(points)(
    "%s に打っても再生が最終 doc と一致する",
    async (_n, plan) => {
      let count = 0;
      const typeOnce = () => type(`+${(count += 1)}`);
      await saveHoldingWindowOpen(
        plan(() => {
          typeOnce();
          typeOnce();
        }),
      );
      await flushStrict();

      expect(native.snapshots.length).toBe(2);
      expectReplayMatchesEditor();
      expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(0);
    },
  );

  it("(b) flushStrict の IPC の間に打っても一致する", async () => {
    native.onAppend = () => {
      native.onAppend = null;
      type("+1");
      type("+2");
    };

    await startSave();
    await flushStrict();

    expectReplayMatchesEditor();
    expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(0);
  });

  it("窓のすべての時点で打っても一致する", async () => {
    let count = 0;
    const t = () => type(`+${(count += 1)}`);
    native.onAppend = () => {
      native.onAppend = null;
      t();
    };

    await saveHoldingWindowOpen({
      beforeFlush: t,
      atCommitStart: t,
      beforeTx: t,
      afterTx: t,
      inProject: t,
    });
    t();
    await flushStrict();

    expectReplayMatchesEditor();
  });

  it("release は renderer projection の前：projection の最中の step は預からず通常どおり queue に入る", async () => {
    let inside: { activeCaptures: number; queueLength: number } | null = null;

    await startSave({
      inProject: () => {
        type("+1");
        inside = _inspectOwnSaveCapturesForTests(ID);
      },
    });

    expect(inside).toMatchObject({ activeCaptures: 0, queueLength: 1 });
    await flushStrict();
    expectReplayMatchesEditor();
  });

  it("commit が失敗して snapshot が無くても、step 列は seed から連続して再生できる", async () => {
    let count = 0;
    const t = () => type(`+${(count += 1)}`);

    await expect(
      startSave({
        beforeFlush: t,
        beforeTx: t,
        failCommit: true,
      }),
    ).rejects.toThrow("bundle failed");
    await flushStrict();

    // 新しい snapshot は無く、再生は seed（anchor 0）から全 step を順に当てる。
    expect(native.snapshots).toHaveLength(1);
    expectReplayMatchesEditor();
    expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(0);
  });

  it("flushStrict が失敗しても、held は T0 以前の未 flush の step の後ろに並び、再試行で連続する", async () => {
    type("+1");
    native.failNextAppend = true;

    await expect(startSave({ beforeFlush: () => type("+2") })).rejects.toThrow(
      "append failed",
    );
    // release は内側の finally が行う。
    expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(0);
    await flushStrict();

    expect(native.snapshots).toHaveLength(1);
    expectReplayMatchesEditor();
  });
});

describe("T-1 (f) 窓の途中で recorder の bind が完了する", () => {
  it("保存の開始時は未 bind。bind 後の step は held に入り、debounce の flush timer を進めても出ない", async () => {
    publishCurrentProjectId(P);
    setCurrentWorkspaceIdentity({
      path: "/workspace/own-save-t1.gdx",
      openRevision: 1,
    });
    createEditor("start");
    // 未 bind の間に打った分は記録されないが、T0 の snapshot に含まれる。
    type("-unbound");
    vi.useFakeTimers();

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const done = startSave({
      beforeTx: () => {
        void initRecorderForProject(P).then(() => {
          type("+1");
          type("+2");
        });
      },
      gate,
    });
    // bind の完了を待ち、debounce の 100ms を十分に超えて進める（窓は開いたまま）。
    await vi.advanceTimersByTimeAsync(1000);
    const observed = {
      appended: native.events.length,
      ...(_inspectOwnSaveCapturesForTests(ID) as {
        queueLength: number;
        heldCount: number;
      }),
    };
    openGate();
    await done;
    vi.useRealTimers();
    await flushStrict();

    // 窓の間は held のまま（queue にも Native にも出ていない）。
    expect(observed.appended).toBe(0);
    expect(observed.queueLength).toBe(0);
    expect(observed.heldCount).toBe(2);
    expectReplayMatchesEditor();
    expect(native.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("bind の前に落ちた step は lost で、release は held を捨てて epoch を壊す（再基準化は次の保存）", async () => {
    await initRecorderForProject(P);
    beginWorkspaceSwitch();
    endWorkspaceSwitch();
    createEditor("start");

    const done = startSave({
      beforeFlush: () => type("-dropped"),
      beforeTx: () => {
        void initRecorderForProject(P).then(() => type("+held"));
      },
    });
    await done;
    await flushStrict();

    expect(native.events).toHaveLength(0);
    expect(_inspectOwnSaveCapturesForTests(ID)).toMatchObject({
      activeCaptures: 0,
      document: { broken: true },
    });
  });
});

describe("T-3 (j) 次の body 書込みの flushStrict は前の窓の放流分を見る", () => {
  it("release が tail の内側（project の前）にあるので、次の commit の時点で Native に届いている", async () => {
    await initRecorderForProject(P);
    createEditor("start");
    type("-a");

    let secondSaw = -1;
    let second: Promise<void> | null = null;
    const first = startSave({
      atCommitStart: () => {
        // 最初の保存の窓で打ち、その後に 2 つ目の保存（同じ project の tail の後ろ）を始める。
        type("+held");
        const t0 = editor.doc;
        second = runTimelapseEditorBodyWrite<string, void>(
          { projectId: P, documentIdentity: ID },
          {
            commit: async () => {
              secondSaw = native.events.length;
              native.snapshots.push({
                anchorSequence: native.seq,
                payload: t0.toJSON(),
              });
              return "ok";
            },
            project: async () => undefined,
          },
        );
      },
    });
    await first;
    await second;
    await flushStrict();

    // "-a" と最初の窓の "+held" の両方が、2 つ目の flushStrict の後・tx の前に Native にある。
    expect(secondSaw).toBe(2);
    expectReplayMatchesEditor();
    expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(0);
  });
});

describe("T-3 (t) release の owner：操作が呼ばれずに reject する", () => {
  it("stale な authority で操作が呼ばれなくても外側の task.finally が release し、held は元の順で queue に入る", async () => {
    await initRecorderForProject(P);
    createEditor("start");
    type("-a");
    const commit = vi.fn(async () => "ok");

    const done = runTimelapseEditorBodyWrite<string, void>(
      { projectId: P, documentIdentity: ID },
      { commit, project: async () => undefined },
    );
    type("+1");
    type("+2");
    // 操作が始まる前に quiescence lease を取り、runAfterTimelapseGenesis に操作を呼ばせない。
    const lease = acquireQuiescenceLease("workspace-open");

    await expect(done).rejects.toThrow(/mutation authority is not current/);
    lease.release();

    expect(commit).not.toHaveBeenCalled();
    expect(_inspectOwnSaveCapturesForTests(ID)).toMatchObject({
      activeCaptures: 0,
      queueLength: 3,
    });
    await flushStrict();
    expect(native.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expectReplayMatchesEditor();
  });
});
