import { describe, expect, it } from "vitest";

import {
  canonicalNarrativeScopeV2,
  digestNarrativeScopeV2,
  validateNarrativeScopeV2,
  type NarrativeScopeV2,
} from "./scopeV2";

const validScope = (): NarrativeScopeV2 => ({
  schemaVersion: 2,
  registryVersion: "narrative-scope/2",
  timeline: { kind: "any" },
  worldline: { kind: "any" },
  scene: { kind: "exact", ref: "scene:1" },
  viewpoint: { kind: "any" },
  knowledgeHolder: { kind: "any" },
  audience: { kind: "any" },
  narrativeLayer: { kind: "any" },
  storyTime: { kind: "any" },
  readingOrder: { kind: "any" },
});

describe("Narrative Scope V2 structural contract", () => {
  it("accepts a complete scope and emits the shared canonical JSON digest", async () => {
    const scope = validScope();

    expect(validateNarrativeScopeV2(scope)).toEqual({ valid: true });
    expect(canonicalNarrativeScopeV2(scope)).toBe(
      '{"audience":{"kind":"any"},"knowledgeHolder":{"kind":"any"},"narrativeLayer":{"kind":"any"},"readingOrder":{"kind":"any"},"registryVersion":"narrative-scope/2","scene":{"kind":"exact","ref":"scene:1"},"schemaVersion":2,"storyTime":{"kind":"any"},"timeline":{"kind":"any"},"viewpoint":{"kind":"any"},"worldline":{"kind":"any"}}',
    );
    await expect(digestNarrativeScopeV2(scope)).resolves.toBe(
      "sha256:8b60e41fbbeadaf24e3714d16567733645713ab9cd0350785b7402bc54bba7d7",
    );
  });

  it.each([
    [
      "unknown schema version",
      { schemaVersion: 3 },
      "unsupported-schema-version",
    ],
    [
      "unknown registry version",
      { registryVersion: "narrative-scope/3" },
      "unsupported-registry-version",
    ],
    ["missing axis", { readingOrder: undefined }, "missing-axis"],
    ["unknown axis", { futureAxis: { kind: "any" } }, "unknown-axis"],
  ] as const)("refuses %s", (_label, patch, reason) => {
    const candidate = { ...validScope(), ...patch } as unknown;
    if ("readingOrder" in patch && patch.readingOrder === undefined) {
      delete (candidate as Record<string, unknown>).readingOrder;
    }
    expect(validateNarrativeScopeV2(candidate)).toMatchObject({
      valid: false,
      reason,
    });
  });

  it("refuses unknown constraint vocabularies and malformed intervals", () => {
    expect(
      validateNarrativeScopeV2({
        ...validScope(),
        scene: { kind: "future" },
      }),
    ).toMatchObject({ valid: false, reason: "unsupported-constraint-kind" });

    expect(
      validateNarrativeScopeV2({
        ...validScope(),
        scene: { kind: "exact", ref: "   " },
      }),
    ).toMatchObject({ valid: false, reason: "empty-reference" });

    expect(
      validateNarrativeScopeV2({
        ...validScope(),
        storyTime: { kind: "interval" },
      }),
    ).toMatchObject({ valid: false, reason: "interval-boundary-required" });

    expect(
      validateNarrativeScopeV2({
        ...validScope(),
        readingOrder: {
          kind: "interval",
          from: { ref: "reading:1", inclusive: "yes" },
        },
      }),
    ).toMatchObject({ valid: false, reason: "invalid-interval-boundary" });
  });

  it("keeps unresolved constraints distinct from any and requires a known reason", () => {
    expect(
      validateNarrativeScopeV2({
        ...validScope(),
        audience: {
          kind: "unresolved",
          reason: "missing-reference",
          constraintId: "scope:audience:1",
        },
      }),
    ).toEqual({ valid: true });

    expect(
      validateNarrativeScopeV2({
        ...validScope(),
        audience: { kind: "unresolved", reason: "future-reason" },
      }),
    ).toMatchObject({ valid: false, reason: "unsupported-unresolved-reason" });
  });
});
