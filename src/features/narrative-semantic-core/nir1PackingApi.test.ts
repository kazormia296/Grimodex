import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import { packNir1Context } from "./nir1PackingApi";

describe("NIR-1 packing renderer API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards typed context units as one Native-local request", async () => {
    h.invoke.mockResolvedValueOnce({
      selectedIds: ["raw:scene", "ir:alice"],
      omittedIds: ["graph:bob"],
      usedTokens: 12,
      remainingTokens: 4,
    });

    await packNir1Context({
      budgetTokens: 16,
      items: [
        { kind: "raw", id: "raw:scene", text: "Raw", tokens: 8 },
        {
          kind: "acceptedIr",
          id: "ir:alice",
          text: "Alice",
          tokens: 4,
          atomicGroup: "ir:alice:unit",
        },
        {
          kind: "graphEvidence",
          id: "graph:bob",
          text: "Bob",
          tokens: 8,
          atomicGroup: "graph:bob:unit",
        },
      ],
    });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith("nir1_pack_context", {
      payload: {
        budgetTokens: 16,
        items: [
          { kind: "raw", id: "raw:scene", text: "Raw", tokens: 8 },
          {
            kind: "acceptedIr",
            id: "ir:alice",
            text: "Alice",
            tokens: 4,
            atomicGroup: "ir:alice:unit",
          },
          {
            kind: "graphEvidence",
            id: "graph:bob",
            text: "Bob",
            tokens: 8,
            atomicGroup: "graph:bob:unit",
          },
        ],
      },
    });
  });
});
