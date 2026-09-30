import { describe, expect, it } from "vitest";

import {
  assertValidDomainObjectKey,
  domainObjectKeysEqual,
  domainObjectKeyToString,
  type DomainObjectKey,
} from "./domainObjectKey";

describe("domainObjectKeyToString", () => {
  it("does not collide when identifier values contain delimiters", () => {
    const left: DomainObjectKey = {
      kind: "import-source",
      sourceSetId: "source:object",
    };
    const right: DomainObjectKey = {
      kind: "import-source",
      sourceSetId: "source",
      objectKey: "object",
    };

    expect(domainObjectKeyToString(left)).not.toBe(
      domainObjectKeyToString(right),
    );
    expect(domainObjectKeysEqual(left, right)).toBe(false);
  });

  it("is stable for the same typed key", () => {
    expect(domainObjectKeyToString({ kind: "scene", sceneId: "scene:1" })).toBe(
      '["scene","scene:1"]',
    );
  });

  it("keeps child identities independent from aggregate roots", () => {
    expect(
      domainObjectKeyToString({ kind: "plot-marker", markerId: "marker-1" }),
    ).toBe('["plot-marker","marker-1"]');
    expect(
      domainObjectKeyToString({
        kind: "foreshadow-setup",
        setupId: "setup-1",
      }),
    ).not.toBe(
      domainObjectKeyToString({ kind: "foreshadow", foreshadowId: "setup-1" }),
    );
  });

  it("rejects missing identities instead of coalescing malformed keys", () => {
    expect(() =>
      assertValidDomainObjectKey({ kind: "scene", sceneId: "" }),
    ).toThrow("sceneId is required");
    expect(() =>
      assertValidDomainObjectKey({
        kind: "import-source",
        sourceSetId: "source",
        objectKey: " ",
      }),
    ).toThrow("objectKey is required");
  });
});
