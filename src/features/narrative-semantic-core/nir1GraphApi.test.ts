import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import { queryNir1Graph } from "./nir1GraphApi";

describe("NIR-1 graph renderer API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards only the native-bound graph query", async () => {
    const response = {
      status: "unavailable",
      projectId: "p1",
      querySceneId: "s1",
      scopeRevision: null,
      graph: null,
      reason: "query-context:UnsupportedQueryAxis",
    } as const;
    h.invoke.mockResolvedValueOnce(response);
    const request = {
      expectedWorkspacePath: "/workspace",
      projectId: "p1",
      querySceneId: "s1",
      seedEntityId: "entry:alice",
      privateScope: "must-not-cross",
    };

    await queryNir1Graph(request);

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith("nir1_graph_query", {
      expectedWorkspacePath: "/workspace",
      projectId: "p1",
      querySceneId: "s1",
      seedEntityId: "entry:alice",
    });
  });
});
