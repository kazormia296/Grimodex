import { describe, expect, it } from "vitest";
import { computePlanDigest } from "./commitCoordinator";
import type { CommitOperation } from "./nativeApi";

const sampleOp: CommitOperation = {
  kind: "chronicle.event.create",
  payload: { eventId: "e1" },
  proposalId: "p1",
  revisionId: "r1",
};

describe("computePlanDigest", () => {
  it("omits empty entityBindings so digests match pre-binding Chronicle plans", async () => {
    const without = await computePlanDigest([sampleOp], null);
    const withEmpty = await computePlanDigest([sampleOp], null, []);
    const withNull = await computePlanDigest([sampleOp], null, null);
    expect(without).toBe(withEmpty);
    expect(without).toBe(withNull);
    // Fixture from the pre-entityBindings canonical plan shape.
    expect(without).toBe(
      "21eae6ea2277cefe9feca7b65b57c6e7c61fa09ca629c6c082e0c6a7a356c4eb",
    );
  });

  it("includes entityBindings in the digest when provided", async () => {
    const base = await computePlanDigest([sampleOp], null);
    const withBindings = await computePlanDigest([sampleOp], null, [
      {
        narrativeEntityId: "ent:a",
        codexEntryId: "codex-a",
        source: "existing",
      },
    ]);
    expect(withBindings).not.toBe(base);
  });

  it("canonicalizes binding key order for stable digests", async () => {
    const a = await computePlanDigest([sampleOp], "tail-1", [
      { narrativeEntityId: "ent:b", codexEntryId: "b", source: "created" },
      { narrativeEntityId: "ent:a", codexEntryId: "a", source: "existing" },
    ]);
    const b = await computePlanDigest([sampleOp], "tail-1", [
      { narrativeEntityId: "ent:a", codexEntryId: "a", source: "existing" },
      { narrativeEntityId: "ent:b", codexEntryId: "b", source: "created" },
    ]);
    expect(a).toBe(b);
  });
});
