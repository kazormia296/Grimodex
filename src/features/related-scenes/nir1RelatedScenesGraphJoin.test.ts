import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1RelatedScenesIr } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import type { RelatedSceneSelection } from "./selectRelatedScenes";
import { RELATED_SCENES_IR_EXTRA_WAIT_MS } from "./relatedScenesConfig";
import {
  awaitNir1RelatedScenesWithGraph,
  type Nir1GraphArrival,
  type Nir1GraphTicketUse,
} from "./nir1RelatedScenesGraphJoin";

const RAW_READY_AT_MS = 100;
const DEADLINE_MS = RAW_READY_AT_MS + RELATED_SCENES_IR_EXTRA_WAIT_MS;
const AVAILABLE: Nir1RelatedScenesIr = { status: "available", scenes: [] };
const raw: RelatedSceneSelection = { scenes: [], anchorSceneId: null };
const snapshot = { indexUsable: true, querySupported: true };

let clock = RAW_READY_AT_MS;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function start(onSettled?: (use: Nir1GraphTicketUse) => void) {
  const ir = deferred<Nir1RelatedScenesIr>();
  const graph = deferred<Nir1GraphArrival<string>>();
  let listener: (() => void) | null = null;
  let active = true;
  const session = {
    stopReason: null as string | null,
    isActive: () => active,
    subscribeInvalidation: (next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  let current = true;
  const settled: Nir1GraphTicketUse[] = [];
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
    isCurrent: () => current,
    onGraphSettled: (use) => {
      settled.push(use);
      onSettled?.(use);
    },
  });
  return {
    ir,
    graph,
    promise,
    settled,
    setCurrent: (value: boolean) => {
      current = value;
    },
    invalidate: () => listener?.(),
    setActive: (value: boolean) => {
      active = value;
    },
    /** A cancel stops the session with its reason, then notifies the observers. */
    cancel: () => {
      session.stopReason = "cancelled";
      listener?.();
    },
  };
}

describe("awaitNir1RelatedScenesWithGraph", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clock = RAW_READY_AT_MS;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes at Graph arrival when the ready IR came first (T1)", async () => {
    const h = start();
    clock = 103;
    h.ir.resolve(AVAILABLE);
    await flush();
    clock = 106;
    h.graph.resolve({ status: "available", graph: "g" });
    const out = await h.promise;
    expect(out.publishedAtMs).toBe(106);
    expect(out.completion.outcome).toBe("ir-ready");
    expect(out.completion.completedAtMs).toBe(103);
    expect(out.graphOutcome).toBe("graph-ready");
    expect(out.graph).toBe("g");
    expect(out.status).toBe("completed");
    expect(h.settled).toEqual(["used"]);
  });

  it("keeps the ready IR and publishes graph-late at the deadline (T2)", async () => {
    const h = start();
    clock = 103;
    h.ir.resolve(AVAILABLE);
    await flush();
    clock = DEADLINE_MS;
    vi.advanceTimersByTime(20);
    const out = await h.promise;
    expect(out.publishedAtMs).toBeCloseTo(DEADLINE_MS);
    expect(out.completion.outcome).toBe("ir-ready");
    expect(out.graphOutcome).toBe("graph-late");
    expect(out.graph).toBeNull();
    expect(h.settled).toEqual(["unused"]);
    clock = DEADLINE_MS + 1;
    h.graph.resolve({ status: "available", graph: "late" });
    await flush();
    expect(h.settled).toEqual(["unused"]);
  });

  it("publishes at IR arrival when the Graph arrived first (T3)", async () => {
    const h = start();
    clock = 104;
    h.graph.resolve({ status: "available", graph: "g" });
    await flush();
    clock = 107;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.publishedAtMs).toBe(107);
    expect(out.graphOutcome).toBe("graph-ready");
    expect(h.settled).toEqual(["used"]);
  });

  it("does not wait for the deadline when Graph is busy (T4)", async () => {
    const h = start();
    clock = 101;
    h.graph.resolve({ status: "unavailable", reason: "busy" });
    await flush();
    clock = 104;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.publishedAtMs).toBe(104);
    expect(out.graphOutcome).toBe("graph-unavailable:busy");
    expect(h.settled).toEqual(["used"]);
  });

  it("publishes an unavailable IR at once with exact R (T5)", async () => {
    const h = start();
    clock = 102;
    h.ir.resolve({ status: "unavailable", reason: "index-unavailable" });
    const out = await h.promise;
    expect(out.publishedAtMs).toBe(102);
    expect(out.result.kind).toBe("raw");
    expect(out.graphOutcome).toBe("graph-unavailable:cancelled");
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("treats a pending IR at the deadline as a timeout and does not use Graph (T6)", async () => {
    const h = start();
    clock = 105;
    h.graph.resolve({ status: "available", graph: "g" });
    await flush();
    clock = DEADLINE_MS;
    vi.advanceTimersByTime(20);
    const out = await h.promise;
    expect(out.completion.outcome).toBe("timeout");
    expect(out.completion.deadlineExceeded).toBe(true);
    expect(out.graphOutcome).toBe("graph-unavailable:ir-not-ready");
    expect(out.graph).toBeNull();
    expect(h.settled).toEqual(["unused"]);
  });

  it("publishes an invalidation during the Graph wait as invalidated (T7)", async () => {
    const h = start();
    clock = 103;
    h.ir.resolve(AVAILABLE);
    await flush();
    clock = 104;
    h.invalidate();
    const out = await h.promise;
    expect(out.status).toBe("invalidated");
    expect(out.graphOutcome).toBe("graph-unavailable:cancelled");
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("reports cancelled when the owner is no longer current (T8)", async () => {
    const h = start();
    h.setCurrent(false);
    clock = 102;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.status).toBe("cancelled");
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("normalizes an unknown Graph reason to failed (T9)", async () => {
    const h = start();
    clock = 101;
    h.graph.resolve({ status: "unavailable", reason: "native-private-text" });
    await flush();
    clock = 104;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.graphOutcome).toBe("graph-unavailable:failed");
    expect(h.settled).toEqual(["used"]);
  });

  it("reports a rejected Graph promise as failed (T10)", async () => {
    const h = start();
    clock = 101;
    h.graph.reject(new Error("native-private-text"));
    await flush();
    clock = 104;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.graphOutcome).toBe("graph-unavailable:failed");
    expect(h.settled).toEqual(["used"]);
  });

  it("never mixes in a Graph that arrives at the deadline (T11)", async () => {
    const h = start();
    clock = 103;
    h.ir.resolve(AVAILABLE);
    await flush();
    // The Graph arrives exactly at the shared deadline, before the timer runs.
    clock = DEADLINE_MS;
    h.graph.resolve({ status: "available", graph: "late" });
    await flush();
    expect(h.settled).toEqual([]);
    vi.advanceTimersByTime(20);
    const out = await h.promise;
    expect(out.graphOutcome).toBe("graph-late");
    expect(out.graph).toBeNull();
    expect(h.settled).toEqual(["unused"]);
  });

  it("treats an IR that arrives after the session ended as invalidated (T12)", async () => {
    const h = start();
    h.setActive(false);
    clock = 103;
    h.ir.resolve(AVAILABLE);
    const out = await h.promise;
    expect(out.status).toBe("invalidated");
    expect(out.completion.outcome).toBe("invalidated");
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("keeps the cancelled reason when the session is cancelled before the IR (T13)", async () => {
    const h = start();
    h.cancel();
    const out = await h.promise;
    expect(out.status).toBe("cancelled");
    expect(out.completion.outcome).toBe("cancelled");
    expect(h.settled).toEqual(["cancelled"]);
  });

  it("returns its result even when the settle declaration throws (T14)", async () => {
    const h = start(() => {
      throw new Error("settle failed");
    });
    clock = 103;
    h.ir.resolve(AVAILABLE);
    await flush();
    clock = 105;
    h.graph.resolve({ status: "available", graph: "g" });
    const out = await h.promise;
    expect(out.graphOutcome).toBe("graph-ready");
    expect(h.settled).toEqual(["used"]);
    // A later arrival or stop never declares a second time.
    h.invalidate();
    await flush();
    expect(h.settled).toEqual(["used"]);
  });
});
