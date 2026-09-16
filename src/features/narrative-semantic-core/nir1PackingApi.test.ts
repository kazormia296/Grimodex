import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import { packNir1Context } from "./nir1PackingApi";

describe("NIR-1 packing renderer API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards only the renderer-owned Raw context as one Native-local request", async () => {
    h.invoke.mockResolvedValueOnce({
      selectedIds: ["raw:scene"],
      omittedIds: [],
      usedTokens: 8,
      remainingTokens: 8,
    });

    await packNir1Context({
      budgetTokens: 16,
      items: [{ kind: "raw", id: "raw:scene", text: "Raw", tokens: 8 }],
    });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith("nir1_pack_context", {
      payload: {
        budgetTokens: 16,
        items: [{ kind: "raw", id: "raw:scene", text: "Raw", tokens: 8 }],
      },
    });
  });
});
