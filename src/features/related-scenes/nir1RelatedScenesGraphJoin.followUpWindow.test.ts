import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1RelatedScenesIr } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import type { RelatedSceneSelection } from "./selectRelatedScenes";
import {
  RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS,
  RELATED_SCENES_IR_EXTRA_WAIT_MS,
} from "./relatedScenesConfig";
import {
  awaitNir1RelatedScenesWithGraph,
  type Nir1GraphArrival,
  type Nir1GraphTicketUse,
} from "./nir1RelatedScenesGraphJoin";

// K6/4 の批准 12（DR-WF-2）：`graph-ready` を契機にした取り直し（子）の合流にだけ
// Graph の成分の窓 W_f を渡す。IR の deadline は D のまま、公開は 1 回だけ。

const RAW_READY_AT_MS = 100;
const D_AT = RAW_READY_AT_MS + RELATED_SCENES_IR_EXTRA_WAIT_MS;
const WF_AT = RAW_READY_AT_MS + RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS;
const AVAILABLE: Nir1RelatedScenesIr = { status: "available", scenes: [] };
const raw: RelatedSceneSelection = { scenes: [], anchorSceneId: null };
const snapshot = { indexUsable: true, querySupported: true };

let clock = RAW_READY_AT_MS;
// fake timer の時刻を clock の単位で持つ（fake の 0 ms ＝ clock の Raw-ready）。
let fakeAt = RAW_READY_AT_MS;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/** 時計を at に進め、そこまでの timer を発火させる（timer は at の時刻で走る）。 */
async function advanceTo(at: number): Promise<void> {
  clock = at;
  if (at > fakeAt) {
    await vi.advanceTimersByTimeAsync(at - fakeAt);
    fakeAt = at;
  }
  await flush();
}

function start(graphWindowMs?: number) {
  const ir = deferred<Nir1RelatedScenesIr>();
  const graph = deferred<Nir1GraphArrival<string>>();
  let listener: (() => void) | null = null;
  const session = {
    stopReason: null as string | null,
    isActive: () => true,
    subscribeInvalidation: (next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const settled: Nir1GraphTicketUse[] = [];
  let resolved = 0;
  const promise = awaitNir1RelatedScenesWithGraph<string>({
    raw,
    rawReadyAtMs: RAW_READY_AT_MS,
    snapshot,
    ir: ir.promise,
    graph: graph.promise,
    session: session as unknown as Pick<
      Nir1RelatedScenesSession,
      "stopReason" | "isActive" | "subscribeInvalidation"
    >,
    isCurrent: () => true,
    onGraphSettled: (use) => settled.push(use),
    ...(graphWindowMs !== undefined ? { graphWindowMs } : {}),
  });
  void promise.then(() => {
    resolved += 1;
  });
  return {
    ir,
    graph,
    promise,
    settled,
    resolved: () => resolved,
    invalidate: () => listener?.(),
    cancel: () => {
      session.stopReason = "cancelled";
      listener?.();
    },
  };
}

describe("follow-up の子の Graph の窓 W_f（K6/4 の批准 12）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clock = RAW_READY_AT_MS;
    fakeAt = RAW_READY_AT_MS;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("W_f は D より長い 100 ms で、D の値は変えない", () => {
    expect(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS).toBe(100);
    expect(RELATED_SCENES_IR_EXTRA_WAIT_MS).toBe(10.840000000596048);
  });

  it("子は IR が ready でも D で公開せず、W_f の内に届いた Graph で 1 回だけ公開する", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    clock = 106;
    h.ir.resolve(AVAILABLE);
    await flush();
    await advanceTo(D_AT + 1);
    // D を過ぎても公開しない（R+IR を先に出す二段公開をしない）。
    expect(h.resolved()).toBe(0);
    expect(h.settled).toEqual([]);
    clock = RAW_READY_AT_MS + 14;
    h.graph.resolve({ status: "available", graph: "g" });
    const out = await h.promise;
    expect(out.status).toBe("completed");
    expect(out.publishedAtMs).toBe(RAW_READY_AT_MS + 14);
    expect(out.completion.outcome).toBe("ir-ready");
    expect(out.completion.completedAtMs).toBe(106);
    expect(out.completion.deadlineExceeded).toBe(false);
    expect(out.graphOutcome).toBe("graph-ready");
    expect(out.graph).toBe("g");
    expect(out.graphWindowMs).toBe(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    expect(h.settled).toEqual(["used"]);
    await advanceTo(WF_AT + 5);
    expect(h.resolved()).toBe(1);
    expect(h.settled).toEqual(["used"]);
  });

  it("子は Graph が来なければ W_f の満了で graph-late を 1 回だけ公開し、その後の Graph を混ぜない", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    clock = 105;
    h.ir.resolve(AVAILABLE);
    await flush();
    await advanceTo(D_AT + 1);
    expect(h.resolved()).toBe(0);
    await advanceTo(WF_AT - 1);
    expect(h.resolved()).toBe(0);
    await advanceTo(WF_AT);
    const out = await h.promise;
    expect(out.publishedAtMs).toBeGreaterThanOrEqual(WF_AT);
    expect(out.graphOutcome).toBe("graph-late");
    expect(out.graph).toBeNull();
    expect(out.completion.outcome).toBe("ir-ready");
    expect(h.settled).toEqual(["unused"]);
    clock = WF_AT + 3;
    h.graph.resolve({ status: "available", graph: "late" });
    await flush();
    expect(h.resolved()).toBe(1);
    expect(h.settled).toEqual(["unused"]);
    expect(out.graph).toBeNull();
  });

  it("子の窓の境界：W_f ちょうどに届いた Graph は混ぜない", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    clock = 105;
    h.ir.resolve(AVAILABLE);
    await flush();
    // timer より先に Graph の到着が走る場合も、窓の時刻以降なら捨てる。
    clock = WF_AT;
    h.graph.resolve({ status: "available", graph: "edge" });
    await flush();
    await advanceTo(WF_AT + 1);
    const out = await h.promise;
    expect(out.graphOutcome).toBe("graph-late");
    expect(out.graph).toBeNull();
    expect(h.settled).toEqual(["unused"]);
  });

  it("子の IR の deadline は D のまま：IR が D までに来なければ D で IR の timeout として公開する", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    await advanceTo(D_AT);
    const out = await h.promise;
    expect(out.publishedAtMs).toBeLessThan(RAW_READY_AT_MS + 20);
    expect(out.completion.outcome).toBe("timeout");
    expect(out.completion.deadlineExceeded).toBe(true);
    expect(out.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "timeout" },
    });
    expect(h.settled).toEqual(["unused"]);
    // W_f の内に Graph が来ても、IR の timeout の後の合流には混ぜない。
    clock = RAW_READY_AT_MS + 30;
    h.graph.resolve({ status: "available", graph: "g" });
    clock = RAW_READY_AT_MS + 31;
    h.ir.resolve(AVAILABLE);
    await flush();
    expect(h.resolved()).toBe(1);
    expect(out.graph).toBeNull();
  });

  it("子の IR が D の後に届いても IR の timeout で、W_f を IR に当てない", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    // timer より先に遅れた IR の到着が走った場合。
    clock = D_AT + 2;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.completion.outcome).toBe("timeout");
    expect(out.result.kind).toBe("raw");
    expect(out.graph).toBeNull();
  });

  it("子が W_f を待つ間の invalidation は即座に invalidated で 1 回だけ公開する", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    clock = 105;
    h.ir.resolve(AVAILABLE);
    await flush();
    await advanceTo(D_AT + 10);
    expect(h.resolved()).toBe(0);
    h.invalidate();
    const out = await h.promise;
    expect(out.status).toBe("invalidated");
    expect(out.publishedAtMs).toBe(D_AT + 10);
    expect(out.graph).toBeNull();
    clock = RAW_READY_AT_MS + 40;
    h.graph.resolve({ status: "available", graph: "g" });
    await advanceTo(WF_AT + 1);
    expect(h.resolved()).toBe(1);
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("子が W_f を待つ間の cancel は即座に cancelled で公開する", async () => {
    const h = start(RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS);
    clock = 105;
    h.ir.resolve(AVAILABLE);
    await flush();
    await advanceTo(D_AT + 10);
    h.cancel();
    const out = await h.promise;
    expect(out.status).toBe("cancelled");
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("窓を渡さない合流（親とほかの契機）は D のままで、D の後の Graph を混ぜない", async () => {
    const h = start();
    clock = 105;
    h.ir.resolve(AVAILABLE);
    await flush();
    await advanceTo(D_AT);
    const out = await h.promise;
    expect(out.publishedAtMs).toBeLessThan(RAW_READY_AT_MS + 20);
    expect(out.graphOutcome).toBe("graph-late");
    expect(out.graphWindowMs).toBe(RELATED_SCENES_IR_EXTRA_WAIT_MS);
    clock = RAW_READY_AT_MS + 14;
    h.graph.resolve({ status: "available", graph: "late" });
    await flush();
    expect(out.graph).toBeNull();
    expect(h.settled).toEqual(["unused"]);
  });

  it("D を明示した合流は窓を渡さない合流と同じ", async () => {
    const h = start(RELATED_SCENES_IR_EXTRA_WAIT_MS);
    clock = 105;
    h.ir.resolve(AVAILABLE);
    await flush();
    await advanceTo(D_AT);
    const out = await h.promise;
    expect(out.graphOutcome).toBe("graph-late");
    expect(out.graphWindowMs).toBe(RELATED_SCENES_IR_EXTRA_WAIT_MS);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 10])(
    "D より短いか有限でない窓（%s）は受け付けない",
    async (value) => {
      expect(() => start(value)).toThrow();
    },
  );
});
