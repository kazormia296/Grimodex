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
      extra: "x",
    });
    await expect(qualifyNir1GraphEvidence("nav-1")).resolves.toStrictEqual(
      qualified,
    );
  });

  it("refuses an IR-arm answer, or any IR-only field, as unavailable:failed (F2)", async () => {
    const irOnly = {
      sourceVersion: 4,
      storageDigest: "digest",
      canonicalTextDigest: "digest",
      normalizerVersion: "n",
      fullQuote: "full quote",
    };
    const answers: unknown[] = [{ ...qualified, ...irOnly }];
    for (const [field, value] of Object.entries(irOnly))
      answers.push({ ...qualified, [field]: value });
    // Present even with an empty or undefined value: still the IR arm.
    answers.push({ ...qualified, fullQuote: "" });
    answers.push({ ...qualified, storageDigest: undefined });
    for (const answer of answers) {
      h.invoke.mockResolvedValueOnce(answer);
      await expect(qualifyNir1GraphEvidence("nav-1")).resolves.toStrictEqual({
        status: "unavailable",
        reason: "failed",
      });
    }
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
