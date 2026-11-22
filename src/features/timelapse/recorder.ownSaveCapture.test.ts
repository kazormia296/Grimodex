// @vitest-environment happy-dom
//
// 自分の保存の capture hold（EAR-1、起案 §3.3b・T-3）の recorder 単体の試験。
// 窓内の doc.step は「held に積む」「lost に数える」「外部 fence に拒まれる」のどれかで、
// queue に直行しない。release の規則と墓標（世代が進んだ hold）を固定する。

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

import {
  _inspectOwnSaveCapturesForTests,
  _resetRecorderForTests,
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
  flushNow,
  flushStrict,
  initRecorderForProject as initRecorderForProjectImpl,
  recordChangeEvent,
  resetRecorderChain,
  setRecorderEnabled,
} from "./recorder";
import {
  acquireTimelapseReplacementFence,
  breakTimelapseDocumentCapture,
  createTimelapseDocumentCaptureAccumulator,
  isTimelapseReplacementFenceActive,
  openOwnSaveCapture,
  type TimelapseDocumentIdentity,
} from "./documentCoverage";
import { isExclusiveDocumentLeaseActive } from "@/features/editor/document/documentSaveCoordinator";
import { beginTimelapseGenesisBarrier } from "./genesisBarrier";
import { debugLog } from "@/lib/debugLog";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { _resetQuiescenceLeasesForTests } from "@/application/lifecycle/quiescenceLease";

const P = "p-own";
const Q = "p-other";

function identity(
  overrides: Partial<TimelapseDocumentIdentity> = {},
): TimelapseDocumentIdentity {
  return {
    projectId: P,
    domain: "editor",
    entityType: "scene",
    entityId: "scene-1",
    storage: "database",
    ...overrides,
  };
}

const ID = identity();

/** recorder.test.ts と同じ。切替・束縛の権限が要る flush のために project を公開する。 */
async function initRecorderForProject(projectId: string): Promise<boolean> {
  publishCurrentProjectId(projectId);
  if (getCurrentWorkspaceIdentity() === null) {
    setCurrentWorkspaceIdentity({
      path: "/workspace/own-save-capture-test.gdx",
      openRevision: 1,
    });
  }
  return initRecorderForProjectImpl(projectId);
}

interface Native {
  seq: number;
  /** flush で Native に届いた doc.step の label を届いた順に持つ。 */
  labels: string[];
  appendCalls: number;
}

function setupNative(): Native {
  const native: Native = { seq: 0, labels: [], appendCalls: 0 };
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
      args: { events: Array<{ opType: string; payload: string }> },
    ) => {
      expect(cmd).toBe("timelapse_append_batch");
      native.appendCalls += 1;
      for (const event of args.events) {
        native.seq += 1;
        if (event.opType !== "doc.step") continue;
        const parsed = JSON.parse(event.payload) as { steps: string[] };
        native.labels.push(parsed.steps[0]);
      }
      return { tailSequence: native.seq };
    },
  );
  return native;
}

function step(
  label: string,
  overrides: Partial<Parameters<typeof recordChangeEvent>[0]> = {},
) {
  return recordChangeEvent({
    domain: "editor",
    opType: "doc.step",
    projectId: P,
    entityType: "scene",
    entityId: "scene-1",
    payload: { steps: [label] },
    ...overrides,
  });
}

function inspect() {
  return _inspectOwnSaveCapturesForTests(ID);
}

describe("recorder own-save capture hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRecorderForTests();
    _resetQuiescenceLeasesForTests();
    setRecorderEnabled(true);
    publishCurrentProjectId(null);
    setCurrentWorkspaceIdentity(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("開く", () => {
    it("同期で開き、coverage state を作らず、fence も lease も取らない", async () => {
      setupNative();
      await initRecorderForProject(P);

      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      expect(inspect()).toMatchObject({ activeCaptures: 1, document: null });
      expect(isTimelapseReplacementFenceActive({ projectId: P })).toBe(false);
      expect(
        isExclusiveDocumentLeaseActive({
          kind: "tree",
          id: "scene-1",
          storage: "database",
        }),
      ).toBe(false);
      capture.release();
      expect(inspect().activeCaptures).toBe(0);
    });

    it("project と document の authority が食い違うと throw する", () => {
      expect(() =>
        openOwnSaveCapture({
          projectId: P,
          document: identity({ projectId: Q }),
        }),
      ).toThrow(/mismatched document authority/);
      expect(() =>
        openOwnSaveCapture({ projectId: " ", document: ID }),
      ).toThrow(/needs a project/);
      expect(inspect().activeCaptures).toBe(0);
    });
  });

  describe("(a)(b)(i) 窓内の step は預かり、release で元の順に queue へ", () => {
    it("(a) 窓内の step は queue に出ず flushStrict が空になる。receipt は通常どおり返る", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      const receipt = step("h1");

      expect(receipt?.document).toBeDefined();
      expect(inspect()).toMatchObject({ heldCount: 1, queueLength: 0 });
      await flushStrict();
      expect(native.appendCalls).toBe(0);
      capture.release();
    });

    it("(b) release 後は元の順で queue に入り、その時点で acceptedPrefix が増える", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      step("pre");
      await flushStrict();
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("h1");
      step("h2");
      expect(inspect().document).toMatchObject({ accepted: 1, durable: 1 });

      capture.release();

      expect(inspect()).toMatchObject({
        heldCount: 0,
        queueLength: 2,
        document: { accepted: 3, durable: 1 },
      });
      await flushStrict();
      expect(native.labels).toEqual(["pre", "h1", "h2"]);
      expect(inspect().document).toMatchObject({ accepted: 3, durable: 3 });
    });

    it("(i) commit は cutoff まで prefix を進めるが、窓内の step では進めず durable <= accepted を保つ", async () => {
      setupNative();
      await initRecorderForProject(P);
      step("pre");
      await flushStrict();
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("h1");
      step("h2");

      capture.commit();
      expect(inspect().document).toMatchObject({
        accepted: 1,
        committed: 1,
        durable: 1,
        broken: false,
      });
      capture.release();
      const afterRelease = inspect().document!;
      expect(afterRelease.durable).toBeLessThanOrEqual(afterRelease.accepted);
      await flushStrict();
      expect(inspect().document).toMatchObject({
        accepted: 3,
        committed: 1,
        durable: 3,
      });
    });

    it("release は冪等で、二重呼出しは何も足さない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("h1");

      capture.release();
      capture.release();
      capture.commit();

      await flushStrict();
      expect(native.labels).toEqual(["h1"]);
      expect(inspect().activeCaptures).toBe(0);
    });

    it("window 外の step・doc.step 以外・別の文書は hold の影響を受けない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      step("other-scene", { entityId: "scene-2" });
      const meta = recordChangeEvent({
        domain: "editor",
        opType: "selection.move",
        projectId: P,
        entityType: "scene",
        entityId: "scene-1",
        payload: {},
      });

      expect(meta).not.toBeNull();
      expect(inspect()).toMatchObject({ heldCount: 0, queueLength: 2 });
      capture.release();
      await flushStrict();
      expect(native.labels).toEqual(["other-scene"]);
    });
  });

  describe("(c) commit 失敗・flush 失敗の release", () => {
    it("commit が無いまま release すると T0 以前の未 flush の step の後ろに並ぶ", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      step("pre");
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("h1");

      // T0 以前の step だけが flushStrict で流れる。
      await flushStrict();
      expect(native.labels).toEqual(["pre"]);
      capture.release();
      await flushStrict();

      expect(native.labels).toEqual(["pre", "h1"]);
    });
  });

  describe("(k)(l) lost：held に穴がある", () => {
    it.each([
      [
        "identity",
        (receipt: unknown) => {
          void receipt;
          breakTimelapseDocumentCapture(ID);
        },
      ],
      [
        "ref",
        (receipt: unknown) => {
          breakTimelapseDocumentCapture(
            (
              receipt as {
                document: Parameters<typeof breakTimelapseDocumentCapture>[0];
              }
            ).document,
          );
        },
      ],
    ])(
      "(k) 窓内に %s で break されると commit は broken を解かず、release は held を捨てて broken にする",
      async (_label, breaker) => {
        const native = setupNative();
        await initRecorderForProject(P);
        step("pre");
        await flushStrict();
        const capture = openOwnSaveCapture({ projectId: P, document: ID });
        const receipt = step("h1");
        breaker(receipt);

        capture.commit();
        expect(inspect().document).toMatchObject({ broken: true });
        capture.release();

        expect(inspect()).toMatchObject({
          heldCount: 0,
          queueLength: 0,
          document: { broken: true },
        });
        await flushStrict();
        expect(native.labels).toEqual(["pre"]);
      },
    );

    it("(l) accumulator が既に壊れた editor では、保留で救えず lost になる", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      step("pre");
      await flushStrict();
      const accumulator = createTimelapseDocumentCaptureAccumulator(ID);
      accumulator.markBroken();
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      const receipt = step("h1");
      // pipeline と同じ。壊れた accumulator は valid な receipt でも壊し直す。
      accumulator.accept(receipt);
      capture.commit();
      capture.release();

      expect(inspect().document).toMatchObject({ broken: true });
      expect(inspect().queueLength).toBe(0);
      await flushStrict();
      expect(native.labels).toEqual(["pre"]);
    });
  });

  describe("(e) T0 で既に broken の文書", () => {
    async function brokenDocument(native: Native) {
      await initRecorderForProject(P);
      step("pre");
      await flushStrict();
      breakTimelapseDocumentCapture(ID);
      expect(inspect().document?.broken).toBe(true);
      expect(native.labels).toEqual(["pre"]);
    }

    it("commit 成功なら窓内の step を預かって放流し、再基準化する", async () => {
      const native = setupNative();
      await brokenDocument(native);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      step("h1");
      expect(inspect().heldCount).toBe(1);
      capture.commit();
      capture.release();

      expect(inspect().document).toMatchObject({ broken: false });
      await flushStrict();
      expect(native.labels).toEqual(["pre", "h1"]);
    });

    it("commit が無ければ held を捨てて broken が残る", async () => {
      const native = setupNative();
      await brokenDocument(native);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      step("h1");
      capture.release();

      expect(inspect()).toMatchObject({
        heldCount: 0,
        queueLength: 0,
        document: { broken: true },
      });
      await flushStrict();
      expect(native.labels).toEqual(["pre"]);
    });
  });

  describe("(g) 重なった hold", () => {
    it("step は最後に開いた hold が受け、release は FIFO で整合する", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const first = openOwnSaveCapture({ projectId: P, document: ID });
      step("a");
      const second = openOwnSaveCapture({ projectId: P, document: ID });
      step("b");

      first.release();
      expect(inspect()).toMatchObject({ heldCount: 1, queueLength: 1 });
      second.release();

      await flushStrict();
      expect(native.labels).toEqual(["a", "b"]);
      expect(inspect().activeCaptures).toBe(0);
    });
  });

  describe("(h)(o) 外部 fence は own の hold より優先", () => {
    it("fence が一致する step は従来どおり捨て、lost にも broken にもしない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("held-before-fence");

      const fence = acquireTimelapseReplacementFence({
        projectId: P,
        document: ID,
      });
      const during = step("rejected");
      fence.release();

      expect(during).toBeNull();
      capture.commit();
      capture.release();
      await flushStrict();
      // fence に拒まれた step は lost を立てないので、先に預かった分は放流される。
      expect(native.labels).toEqual(["held-before-fence"]);
      expect(inspect().document).toMatchObject({ broken: false });
    });
  });

  describe("EAR-18 外部置換の commit は、先に開いた hold の置換前の step を捨てる", () => {
    it("同じ文書の置換が commit すると held を捨てる（lost にしない）。release 後に打った step は預かり、放流される", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("pre1");
      step("pre2");
      const warn = vi.spyOn(debugLog, "warn");

      const fence = acquireTimelapseReplacementFence({
        projectId: P,
        document: ID,
      });
      fence.commit();
      expect(inspect().heldCount).toBe(0);
      fence.release();
      // 本文・step の中身は診断に出さず、件数だけ。
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain("pre1");
      expect(warn.mock.calls[0]?.[2]).toMatchObject({
        fields: { outcome: "superseded", heldCount: 2 },
      });

      step("post");
      expect(inspect().heldCount).toBe(1);
      capture.release();
      await flushStrict();
      expect(native.labels).toEqual(["post"]);
      expect(inspect().document).toMatchObject({ broken: false });
    });

    it("codex の identity でも照合される（fence の key と hold の key の符号化の違いを越えて同じ文書に当たる）。scene の同 id には当たらない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const codexId = identity({
        domain: "codex",
        entityType: "codex_entry",
        entityId: "entry-1",
      });
      const codexStep = (label: string) =>
        step(label, {
          domain: "codex",
          entityType: "codex_entry",
          entityId: "entry-1",
        });
      const capture = openOwnSaveCapture({ projectId: P, document: codexId });
      codexStep("pre");
      const sceneCapture = openOwnSaveCapture({ projectId: P, document: ID });
      step("scene-keep");
      expect(_inspectOwnSaveCapturesForTests(codexId).heldCount).toBe(2);

      const fence = acquireTimelapseReplacementFence({
        projectId: P,
        document: codexId,
      });
      fence.commit();
      fence.release();

      // codex の held だけが捨てられ、scene の held は残る。
      expect(_inspectOwnSaveCapturesForTests(codexId).heldCount).toBe(1);
      codexStep("post");
      sceneCapture.release();
      capture.release();
      await flushStrict();
      expect(native.labels).toEqual(["scene-keep", "post"]);
    });

    it("project 全体の置換でも同じ project の hold の held を捨てる。別 project の hold は触らない", async () => {
      setupNative();
      await initRecorderForProject(P);
      const same = openOwnSaveCapture({ projectId: P, document: ID });
      step("pre");
      const other = openOwnSaveCapture({
        projectId: Q,
        document: identity({ projectId: Q, entityId: "scene-q" }),
      });

      const fence = acquireTimelapseReplacementFence({ projectId: P });
      fence.commit();
      fence.release();

      expect(inspect().heldCount).toBe(0);
      expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(2);
      same.release();
      other.release();
    });

    it("別の文書の置換が commit しても held は捨てない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("keep");

      const fence = acquireTimelapseReplacementFence({
        projectId: P,
        document: identity({ entityId: "scene-2" }),
      });
      fence.commit();
      fence.release();

      expect(inspect().heldCount).toBe(1);
      capture.commit();
      capture.release();
      await flushStrict();
      expect(native.labels).toEqual(["keep"]);
    });

    it("commit されなかった置換（release のみ）は held を捨てない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("keep");

      const fence = acquireTimelapseReplacementFence({
        projectId: P,
        document: ID,
      });
      fence.release();

      expect(inspect().heldCount).toBe(1);
      capture.release();
      await flushStrict();
      expect(native.labels).toEqual(["keep"]);
    });

    it("T0 で broken だった hold は、置換の commit が再基準化するので、置換の後の step は own が commit できなくても放流される", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      step("seed");
      breakTimelapseDocumentCapture(ID);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      const fence = acquireTimelapseReplacementFence({
        projectId: P,
        document: ID,
      });
      fence.commit();
      fence.release();
      step("post");
      capture.release();

      await flushStrict();
      expect(native.labels).toEqual(["seed", "post"]);
    });
  });

  describe("(m) recorder が窓の全体で無効", () => {
    it("hold は実の hold で、step は null。state・queue は増えず、ON にした後の記録も止まらない", async () => {
      const native = setupNative();
      setRecorderEnabled(false);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      expect(step("h1")).toBeNull();
      capture.commit();
      capture.release();

      expect(inspect()).toMatchObject({
        activeCaptures: 0,
        queueLength: 0,
        document: null,
      });

      setRecorderEnabled(true);
      await initRecorderForProject(P);
      expect(step("after")).not.toBeNull();
      await flushStrict();
      expect(native.labels).toEqual(["after"]);
    });
  });

  describe("(m2)(m3)(m4) 窓内で記録可に遷移する", () => {
    it("(m2) 窓内で bind が完了した後の step は held に入り、flush timer を進めても queue に出ない", async () => {
      const native = setupNative();
      // 窓の開始時は未 bind（enabled だが projectId が無い）。
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      await initRecorderForProject(P);
      vi.useFakeTimers();

      step("h1");
      step("h2");
      await vi.advanceTimersByTimeAsync(1000);

      expect(native.appendCalls).toBe(0);
      expect(inspect()).toMatchObject({ heldCount: 2, queueLength: 0 });
      capture.commit();
      capture.release();
      expect(inspect().queueLength).toBe(2);
      vi.useRealTimers();
      await flushStrict();
      expect(native.labels).toEqual(["h1", "h2"]);
    });

    it("(m3) bind の前に落ちた step があると lost になり、release は held を捨てて broken。次の保存は再基準化する", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      beginWorkspaceSwitch();
      endWorkspaceSwitch();
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      expect(step("dropped")).toBeNull();
      await initRecorderForProject(P);
      step("h1");
      capture.commit();
      capture.release();

      expect(inspect()).toMatchObject({
        heldCount: 0,
        queueLength: 0,
        document: { broken: true },
      });

      // 次の保存の hold は rebaseline で、commit が broken を戻す。
      const next = openOwnSaveCapture({ projectId: P, document: ID });
      step("h2");
      next.commit();
      next.release();
      expect(inspect().document).toMatchObject({ broken: false });
      await flushStrict();
      expect(native.labels).toEqual(["h2"]);
    });

    it("(m4) setRecorderEnabled(true) が窓内で起きても (m2)(m3) と同じに扱う", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      setRecorderEnabled(false);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });

      // OFF の間に落ちた step で lost。
      expect(step("dropped")).toBeNull();
      setRecorderEnabled(true);
      await initRecorderForProject(P);
      // ON の後は held（世代は進まないので hold は生き残る）。
      step("h1");
      expect(inspect().heldCount).toBe(1);
      capture.commit();
      capture.release();

      expect(inspect()).toMatchObject({ heldCount: 0, queueLength: 0 });
      await flushStrict();
      expect(native.labels).toEqual([]);
    });

    it("(m4b) OFF の間に落ちた step が無ければ、ON の後の step は放流される", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      setRecorderEnabled(false);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      setRecorderEnabled(true);
      await initRecorderForProject(P);

      step("h1");
      capture.commit();
      capture.release();

      await flushStrict();
      expect(native.labels).toEqual(["h1"]);
    });
  });

  describe("(n) project 不一致", () => {
    it("取得後に recorder の project が変わると lost。release は queue に流さず throw しない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("h1");

      // 切替を経ない rebind（世代は進まない）。
      await initRecorderForProject(Q);
      expect(step("h2")).toBeNull();
      capture.commit();
      expect(() => capture.release()).not.toThrow();

      expect(inspect()).toMatchObject({ heldCount: 0, queueLength: 0 });
      await expect(flushStrict()).resolves.toBeUndefined();
      expect(native.labels).toEqual([]);
    });
  });

  describe("genesis の capture 対象（新しい project の活性化中）", () => {
    it("対象 project の窓内の step を預かり、活性化と rebind の後の release で他 project と混ざらず流れる", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const target = identity({ projectId: Q });
      const genesis = beginTimelapseGenesisBarrier(Q);
      const capture = openOwnSaveCapture({ projectId: Q, document: target });

      step("h1", { projectId: Q });
      expect(_inspectOwnSaveCapturesForTests(target)).toMatchObject({
        heldCount: 1,
        queueLength: 0,
      });

      genesis.complete();
      await initRecorderForProject(Q);
      capture.commit();
      expect(() => capture.release()).not.toThrow();

      expect(_inspectOwnSaveCapturesForTests(target).queueLength).toBe(1);
      await flushStrict();
      expect(native.labels).toEqual(["h1"]);
      expect(invokeMock).toHaveBeenCalledWith(
        "timelapse_append_batch",
        expect.objectContaining({ projectId: Q }),
      );
    });
  });

  describe("(n2) project 不一致の release の guard", () => {
    it("lost の step が無くても、project が変わった hold の held は queue に流さず、broken にも触れない", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("h1");

      // 切替を経ない rebind（世代は進まない）。この後 P の step は来ない。
      await initRecorderForProject(Q);
      capture.commit();
      expect(() => capture.release()).not.toThrow();

      // held は捨てられる（mixed Project authority の throw を起こさない）。
      expect(inspect()).toMatchObject({
        activeCaptures: 0,
        heldCount: 0,
        queueLength: 0,
      });
      await expect(flushStrict()).resolves.toBeUndefined();
      expect(native.labels).toEqual([]);
      // rebind が P の state を消している。release が epoch を作り直したり壊したりしていない。
      expect(inspect().document).toBeNull();
    });
  });

  describe("(p) hold の key と step の key が食い違う", () => {
    it("storage が違う step は hold に入らず queue へ直行する（挙動の固定）", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({
        projectId: P,
        document: identity({ storage: "file" }),
      });

      step("db-step");

      expect(inspect()).toMatchObject({ heldCount: 0, queueLength: 1 });
      capture.release();
      await flushStrict();
      expect(native.labels).toEqual(["db-step"]);
    });
  });

  describe("(q) discard／abort", () => {
    it("held は破棄され、件数だけの診断 warn が 1 回出る（本文・step の中身は出ない）", async () => {
      const native = setupNative();
      const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
      await initRecorderForProject(P);
      const capture = openOwnSaveCapture({ projectId: P, document: ID });
      step("secret-body-text");
      step("secret-body-text-2");

      setRecorderEnabled(false);

      const own = warn.mock.calls.filter(([, message]) =>
        String(message).includes("own-save capture"),
      );
      expect(own).toHaveLength(1);
      expect(String(own[0][1])).toContain("2 held step");
      expect(JSON.stringify(own[0])).not.toContain("secret-body-text");
      expect(inspect().heldCount).toBe(0);

      capture.release();
      setRecorderEnabled(true);
      await initRecorderForProject(P);

      // 再開しても壊れず、次の保存が普通に記録される。
      const next = openOwnSaveCapture({ projectId: P, document: ID });
      step("after");
      next.commit();
      next.release();
      await flushStrict();
      expect(native.labels).toEqual(["after"]);
    });
  });

  describe("(r)(s) 墓標", () => {
    const advance: Array<[string, () => Promise<void>]> = [
      [
        "OFF→ON と rebind",
        async () => {
          setRecorderEnabled(false);
          setRecorderEnabled(true);
          await initRecorderForProject(P);
        },
      ],
      [
        "resetRecorderChain",
        async () => {
          resetRecorderChain();
          await initRecorderForProject(P);
        },
      ],
      [
        "workspace の切替",
        async () => {
          beginWorkspaceSwitch();
          endWorkspaceSwitch();
          await initRecorderForProject(P);
        },
      ],
    ];

    it.each(advance)(
      "(r) %s：held は捨てられ warn が 1 回、同じ窓の次の step は null で doc は broken。release は何も流さない",
      async (_label, advanceGeneration) => {
        const native = setupNative();
        const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
        await initRecorderForProject(P);
        const capture = openOwnSaveCapture({ projectId: P, document: ID });
        step("h1");

        await advanceGeneration();

        expect(
          warn.mock.calls.filter(([, message]) =>
            String(message).includes("own-save capture"),
          ),
        ).toHaveLength(1);
        expect(step("after-generation")).toBeNull();
        expect(inspect()).toMatchObject({
          heldCount: 0,
          queueLength: 0,
          document: { broken: true },
        });
        capture.commit();
        expect(() => capture.release()).not.toThrow();
        await flushStrict();
        expect(native.labels).toEqual([]);

        // 続く次の保存の hold は rebaseline で、commit が broken を戻す。
        const next = openOwnSaveCapture({ projectId: P, document: ID });
        step("h2");
        next.commit();
        next.release();
        expect(inspect().document).toMatchObject({ broken: false });
        await flushStrict();
        expect(native.labels).toEqual(["h2"]);
      },
    );

    it("(s) 墓標の hold がある文書に新しい hold を開くと、step は新しい hold が受ける", async () => {
      const native = setupNative();
      await initRecorderForProject(P);
      const old = openOwnSaveCapture({ projectId: P, document: ID });
      step("old");
      setRecorderEnabled(false);
      setRecorderEnabled(true);
      await initRecorderForProject(P);

      const fresh = openOwnSaveCapture({ projectId: P, document: ID });
      step("fresh");

      expect(inspect()).toMatchObject({ activeCaptures: 2, heldCount: 1 });
      old.release();
      expect(inspect().queueLength).toBe(0);
      fresh.commit();
      fresh.release();
      await flushStrict();
      expect(native.labels).toEqual(["fresh"]);
    });

    it("試験の reset は墓標も set も残さない", async () => {
      setupNative();
      await initRecorderForProject(P);
      openOwnSaveCapture({ projectId: P, document: ID });

      _resetRecorderForTests();

      expect(_inspectOwnSaveCapturesForTests(ID).activeCaptures).toBe(0);
    });
  });

  describe("既存の挙動が変わらない", () => {
    it("hold が無ければ doc.step は従来どおり queue に入る", async () => {
      const native = setupNative();
      await initRecorderForProject(P);

      expect(step("plain")?.document).toBeDefined();
      await flushNow();

      expect(native.labels).toEqual(["plain"]);
    });
  });
});
