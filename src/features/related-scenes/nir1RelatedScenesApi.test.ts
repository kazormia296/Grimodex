import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke, listen: h.listen }));

import {
  beginRelatedScenes,
  continueRelatedScenes,
  continueRelatedScenesGraph,
  listenRelatedScenesGraphReady,
  settleRelatedScenesGraph,
  listenRelatedScenesInvalidations,
  listenRelatedScenesIndexReady,
  qualifyNir1Evidence,
  releaseRelatedScenes,
} from "./nir1RelatedScenesApi";

beforeEach(() => vi.clearAllMocks());

describe("Related Scenes typed renderer wire", () => {
  it("sends only the approved begin request fields and preserves the Raw query bytes", async () => {
    const input = {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s2",
      query: "  Saved query\n",
      ownerKey: "renderer-must-not-send",
      forbiddenPool: ["private"],
    };
    h.invoke.mockResolvedValueOnce({ status: "raw-ready" });
    await beginRelatedScenes(input);
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith("related_scenes_begin", {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s2",
      query: "  Saved query\n",
    });
  });

  it("keeps continuation, release and qualification capabilities opaque", async () => {
    await continueRelatedScenes("opaque-ticket");
    await releaseRelatedScenes("opaque-ticket");
    await qualifyNir1Evidence("opaque-navigation");
    expect(h.invoke.mock.calls).toEqual([
      ["related_scenes_continue", { operationTicket: "opaque-ticket" }],
      ["related_scenes_release", { operationTicket: "opaque-ticket" }],
      ["nir1_evidence_qualify", { navigationIdentity: "opaque-navigation" }],
    ]);
  });

  it("subscribes to the exact canonical event and exposes only its safe binding", async () => {
    const unlisten = vi.fn();
    h.listen.mockResolvedValueOnce(unlisten);
    const receive = vi.fn();
    expect(await listenRelatedScenesInvalidations(receive)).toBe(unlisten);
    expect(h.listen.mock.calls[0][0]).toBe("related-scenes:invalidated");
    const notify = h.listen.mock.calls[0][1] as (payload: unknown) => void;
    notify({
      queryBinding: "query-a",
      privateDetail: "must not reach observer",
    });
    notify(undefined);
    notify({ queryBinding: 1 });
    notify({ queryBinding: "" });
    expect(receive).toHaveBeenCalledExactlyOnceWith("query-a");
  });

  it("subscribes to sealed Index readiness with a safe Project identity only", async () => {
    const unlisten = vi.fn();
    h.listen.mockResolvedValueOnce(unlisten);
    const receive = vi.fn();
    expect(await listenRelatedScenesIndexReady(receive)).toBe(unlisten);
    expect(h.listen.mock.calls[0][0]).toBe("related-scenes:index-ready");
    const notify = h.listen.mock.calls[0][1] as (payload: unknown) => void;
    notify({ projectId: "p1", hiddenCount: 42 });
    notify(undefined);
    notify({ projectId: "" });
    expect(receive).toHaveBeenCalledExactlyOnceWith("p1");
  });

  it("sends the Graph seed only when the caller passes one", async () => {
    h.invoke.mockResolvedValue({ status: "raw-ready" });
    const base = {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s2",
      query: "q",
    };
    await beginRelatedScenes(base);
    expect(h.invoke.mock.calls[0][1]).toStrictEqual(base);
    expect("graphSeedEntityId" in h.invoke.mock.calls[0][1]).toBe(false);
    await beginRelatedScenes({ ...base, graphSeedEntityId: "entity-1" });
    expect(h.invoke.mock.calls[1]).toEqual([
      "related_scenes_begin",
      { ...base, graphSeedEntityId: "entity-1" },
    ]);
  });

  it("uses one command for the Graph wait and the settle, each with its exact keys", async () => {
    const ids = ["a", "b"];
    await continueRelatedScenesGraph("opaque-ticket", ids);
    await settleRelatedScenesGraph("opaque-ticket", "unused");
    expect(h.invoke.mock.calls).toEqual([
      [
        "related_scenes_graph_continue",
        { operationTicket: "opaque-ticket", rawSceneIds: ["a", "b"] },
      ],
      [
        "related_scenes_graph_continue",
        { operationTicket: "opaque-ticket", settle: "unused" },
      ],
    ]);
    // The wait copies the IDs; the settle carries no Scene ID at all.
    expect(h.invoke.mock.calls[0][1].rawSceneIds).not.toBe(ids);
    expect("rawSceneIds" in h.invoke.mock.calls[1][1]).toBe(false);
  });

  it("subscribes to graph-ready and exposes only its Project identity", async () => {
    const unlisten = vi.fn();
    h.listen.mockResolvedValueOnce(unlisten);
    const receive = vi.fn();
    expect(await listenRelatedScenesGraphReady(receive)).toBe(unlisten);
    expect(h.listen.mock.calls[0][0]).toBe("related-scenes:graph-ready");
    const notify = h.listen.mock.calls[0][1] as (payload: unknown) => void;
    notify({ projectId: "p1", pathAttachments: ["must not reach observer"] });
    notify(undefined);
    notify({ projectId: "" });
    notify({ projectId: 3 });
    expect(receive).toHaveBeenCalledExactlyOnceWith("p1");
  });
});
