import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import { qualifyNir1GraphEvidence } from "./nir1GraphApi";

const qualified = {
  status: "qualified",
  bindingKey: "nav-1",
  queryBinding: "qb",
  sceneId: "g",
  canonicalRange: { start: 3, end: 9 },
};

describe("NIR-1 Graph-only click qualification (CP-3b)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards only the navigation identity to nir1_evidence_qualify", async () => {
    h.invoke.mockResolvedValueOnce(qualified);
    await qualifyNir1GraphEvidence("nav-1");
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith("nir1_evidence_qualify", {
      navigationIdentity: "nav-1",
    });
  });

  it("copies only the digest-free fields", async () => {
    h.invoke.mockResolvedValueOnce({
      ...qualified,
      canonicalRange: { start: 3, end: 9, extra: "x" },
      canonicalTextDigest: "digest",
      storageDigest: "digest",
      sourceVersion: 4,
      fullQuote: "full quote",
      normalizerVersion: "n",
    });
    await expect(qualifyNir1GraphEvidence("nav-1")).resolves.toStrictEqual(
      qualified,
    );
  });

  it("keeps a closed unavailable reason", async () => {
    for (const reason of ["invalidated", "cancelled", "failed"]) {
      h.invoke.mockResolvedValueOnce({ status: "unavailable", reason });
      await expect(qualifyNir1GraphEvidence("nav-1")).resolves.toStrictEqual({
        status: "unavailable",
        reason,
      });
    }
  });

  it("a malformed answer is unavailable:failed", async () => {
    for (const answer of [
      null,
      "qualified",
      { status: "unavailable", reason: "expired" },
      { status: "unavailable", reason: "private detail" },
      { ...qualified, status: "ok" },
      { ...qualified, bindingKey: "" },
      { ...qualified, queryBinding: 1 },
      { ...qualified, sceneId: undefined },
      { ...qualified, canonicalRange: null },
      { ...qualified, canonicalRange: { start: "3", end: 9 } },
      { ...qualified, canonicalRange: { start: 0.5, end: 9 } },
    ]) {
      h.invoke.mockResolvedValueOnce(answer);
      await expect(qualifyNir1GraphEvidence("nav-1")).resolves.toStrictEqual({
        status: "unavailable",
        reason: "failed",
      });
    }
  });
});
