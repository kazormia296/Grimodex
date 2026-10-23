// @vitest-environment happy-dom
/**
 * CP-3a（DR-CP3A-45）：Graph の settle が、実行中の待受けの後ろに並ばないこと。
 *
 * `nir1RelatedScenesApi` も `@/lib/tauri` も `ipcQueue` も実物を通し、Electron の
 * transport（`window.grimodex.invoke`）だけを fake にする。fake の待受けは Native の
 * `await_graph` と同じく、settle を受け取れば 1 step（25 ms）後に `cancelled` で戻り、
 * 受け取らなければ 2 s で `timeout` を返す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelatedScenesBeginResponse } from "@/../electron/shared/relatedScenesSearchWire";

type AnyWindow = Record<string, unknown>;
type TransportCall = {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly at: number;
};

const AWAIT_LIMIT_MS = 2_000;
const AWAIT_STEP_MS = 25;
const IR_CONTINUE_MS = 30;

function installTransport() {
  const calls: TransportCall[] = [];
  const settled: number[] = [];
  let endAwait: (() => void) | null = null;
  const ok = (value: unknown) => ({ ok: true as const, value });
  const invoke = vi.fn(
    (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args, at: Date.now() });
      switch (command) {
        case "related_scenes_continue":
          return new Promise((resolve) =>
            setTimeout(
              () => resolve(ok({ status: "available", scenes: [] })),
              IR_CONTINUE_MS,
            ),
          );
        case "related_scenes_graph_continue":
          if ("settle" in args) {
            endAwait?.();
            return Promise.resolve(ok({ status: "settled" }));
          }
          return new Promise((resolve) => {
            const finish = (reason: string) => {
              settled.push(Date.now());
              resolve(ok({ status: "unavailable", reason }));
            };
            const limit = setTimeout(() => finish("timeout"), AWAIT_LIMIT_MS);
            endAwait = () => {
              clearTimeout(limit);
              setTimeout(() => finish("cancelled"), AWAIT_STEP_MS);
            };
          });
        case "related_scenes_begin":
          return Promise.resolve(
            ok({
              status: "raw-ready",
              denseHits: [],
              snapshot: {
                queryBinding: "query-2",
                originalSnapshotUsable: true,
                supportedProfile: true,
              },
              ir: { status: "unavailable", reason: "index-unavailable" },
            }),
          );
        case "related_scenes_release":
          return Promise.resolve(ok({ status: "released" }));
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    },
  );
  (window as unknown as AnyWindow).grimodex = {
    shell: "electron",
    invoke,
    listen: vi.fn(() => () => {}),
    emit: vi.fn().mockResolvedValue(undefined),
  };
  return { calls, settled };
}

function callAt(
  calls: readonly TransportCall[],
  command: string,
  shape?: "settle" | "await",
): TransportCall | undefined {
  return calls.find(
    (call) =>
      call.command === command &&
      (shape === undefined || "settle" in call.args === (shape === "settle")),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  delete (window as unknown as AnyWindow).grimodex;
  vi.useRealTimers();
});

describe("Related Scenes Graph settle lane (CP-3a, DR-CP3A-45)", () => {
  it("sends settle while the await holds the derived slot, so the await ends and the next begin does not wait 2 s", async () => {
    const transport = installTransport();
    const [api, graphModule, queue] = await Promise.all([
      import("./nir1RelatedScenesApi"),
      import("./fetchNir1RelatedScenesGraph"),
      import("@/lib/ipcQueue"),
    ]);
    queue.resetIpcQueueForTests();

    // t=0: the IR continue occupies the derived slot for 30 ms.
    const ir = api.continueRelatedScenes("ticket-1");
    await vi.advanceTimersByTimeAsync(5);
    // t=5: the Graph await is queued behind it (both are derived).
    const graphWait = graphModule.createNir1RelatedScenesGraphWait({
      begin: {
        graph: { status: "pending" },
      } as unknown as RelatedScenesBeginResponse,
      operationTicket: "ticket-1",
      queryBinding: "query-1",
      canWait: () => true,
    });
    expect(graphWait).not.toBeNull();
    const arrival = graphWait!.arrival(["scene-a"]);
    await vi.advanceTimersByTimeAsync(35);
    // t=40: the deadline passed; the renderer declares `unused`, then releases
    // the operation once the declaration has reached Native (DR-CP3A-42).
    graphWait!.settle("unused");
    const released = graphWait!
      .settled()
      .then(() => api.releaseRelatedScenes("ticket-1"));
    await vi.advanceTimersByTimeAsync(60);
    // t=100: the next scene's query.
    const next = api.beginRelatedScenes({
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      currentSceneId: "scene-2",
      query: "next scene",
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(ir).resolves.toMatchObject({ status: "available" });
    // The await itself stays in the derived lane, behind the IR continue.
    expect(
      callAt(transport.calls, "related_scenes_graph_continue", "await")?.at,
    ).toBe(IR_CONTINUE_MS);
    // The settle is sent at once, not after the await's 2 s limit.
    expect(
      callAt(transport.calls, "related_scenes_graph_continue", "settle"),
    ).toEqual({
      command: "related_scenes_graph_continue",
      args: { operationTicket: "ticket-1", settle: "unused" },
      at: 40,
    });
    // The await observed it and came back `cancelled` one step later.
    expect(transport.settled).toEqual([40 + AWAIT_STEP_MS]);
    await expect(arrival).resolves.toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    // Release follows the declaration's arrival, never overtakes it.
    await released;
    const settleIndex = transport.calls.findIndex(
      (call) => "settle" in call.args,
    );
    const releaseIndex = transport.calls.findIndex(
      (call) => call.command === "related_scenes_release",
    );
    expect(releaseIndex).toBeGreaterThan(settleIndex);
    expect(transport.calls[releaseIndex]!.at).toBe(40);
    // The next begin found the derived slot free.
    await expect(next).resolves.toMatchObject({ status: "raw-ready" });
    expect(callAt(transport.calls, "related_scenes_begin")?.at).toBe(100);
  });
});
