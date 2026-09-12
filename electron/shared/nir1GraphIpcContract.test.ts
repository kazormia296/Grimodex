import { describe, expect, it, vi } from "vitest";

import { dispatchInvoke } from "./ipcContract.js";
import type { NapiBackendLike } from "./ipcContract.js";

describe("NIR-1 bounded graph IPC contract", () => {
  it("keeps the unactivated graph scaffold out of renderer IPC", async () => {
    const nir1GraphQuery = vi.fn();
    const backend = { nir1GraphQuery } as unknown as NapiBackendLike;

    const result = await dispatchInvoke(
      "nir1_graph_query",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        querySceneId: "scene-1",
        seedEntityId: "entry-1",
      },
      { backend, shell: {} as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("IPC_UNIMPLEMENTED: nir1_graph_query");
    }
    expect(nir1GraphQuery).not.toHaveBeenCalled();
  });

  it("stays unavailable even when a renderer supplies a complete request", async () => {
    const nir1GraphQuery = vi.fn();
    const result = await dispatchInvoke(
      "nir1_graph_query",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        querySceneId: "scene-1",
        seedEntityId: "entry-1",
      },
      {
        backend: { nir1GraphQuery } as unknown as NapiBackendLike,
        shell: {} as never,
      },
    );

    expect(result.ok).toBe(false);
    expect(nir1GraphQuery).not.toHaveBeenCalled();
  });

  it("strips packing payload extras and preserves atomic group fields", async () => {
    const nir1PackContext = vi.fn().mockResolvedValue(
      JSON.stringify({
        selectedIds: ["raw:scene"],
        omittedIds: ["ir:alice"],
        usedTokens: 8,
        remainingTokens: 0,
      }),
    );
    const backend = { nir1PackContext } as unknown as NapiBackendLike;

    const result = await dispatchInvoke(
      "nir1_pack_context",
      {
        payload: {
          budgetTokens: 8,
          items: [
            {
              kind: "raw",
              id: "raw:scene",
              text: "Raw",
              tokens: 8,
              rendererOnly: true,
            },
            {
              kind: "acceptedIr",
              id: "ir:alice",
              text: "Alice",
              tokens: 4,
              atomicGroup: "ir:alice:unit",
            },
          ],
        },
      },
      { backend, shell: {} as never },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        selectedIds: ["raw:scene"],
        omittedIds: ["ir:alice"],
        usedTokens: 8,
        remainingTokens: 0,
      },
    });
    expect(nir1PackContext).toHaveBeenCalledExactlyOnceWith({
      budgetTokens: 8,
      items: [
        { kind: "raw", id: "raw:scene", text: "Raw", tokens: 8 },
        {
          kind: "acceptedIr",
          id: "ir:alice",
          text: "Alice",
          tokens: 4,
          atomicGroup: "ir:alice:unit",
        },
      ],
    });
  });

  it("rejects zero packing budgets before Native dispatch", async () => {
    const nir1PackContext = vi.fn();
    const result = await dispatchInvoke(
      "nir1_pack_context",
      { payload: { budgetTokens: 0, items: [] } },
      {
        backend: { nir1PackContext } as unknown as NapiBackendLike,
        shell: {} as never,
      },
    );

    expect(result.ok).toBe(false);
    expect(nir1PackContext).not.toHaveBeenCalled();
  });
});
