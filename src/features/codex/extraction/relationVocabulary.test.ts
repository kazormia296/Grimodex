import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODEX_RELATION_VOCABULARY,
  buildCodexRelationSemanticKey,
  normalizeRelationLabel,
  resolveCodexRelationVocabulary,
} from "./relationVocabulary";

describe("normalizeRelationLabel", () => {
  it("NFC-normalizes, trims, and collapses whitespace", () => {
    expect(normalizeRelationLabel("  父\u3000\u3000子  ")).toBe("父 子");
  });
});

describe("buildCodexRelationSemanticKey", () => {
  it("keeps directed endpoints ordered and treats reverse as distinct", () => {
    const forward = buildCodexRelationSemanticKey({
      projectId: "p1",
      fromCodexId: "a",
      toCodexId: "b",
      relationType: "parent",
      directionality: "directed",
      forwardLabel: "父",
      inverseLabel: "子",
    });
    const reverse = buildCodexRelationSemanticKey({
      projectId: "p1",
      fromCodexId: "b",
      toCodexId: "a",
      relationType: "parent",
      directionality: "directed",
      forwardLabel: "父",
      inverseLabel: "子",
    });
    expect(forward).not.toBe(reverse);
    expect(forward.startsWith("d\t")).toBe(true);
  });

  it("canonicalizes symmetric endpoints so reverse is the same key", () => {
    const ab = buildCodexRelationSemanticKey({
      projectId: "p1",
      fromCodexId: "a",
      toCodexId: "b",
      relationType: "friend",
      directionality: "symmetric",
      forwardLabel: "友人",
      inverseLabel: "友人",
    });
    const ba = buildCodexRelationSemanticKey({
      projectId: "p1",
      fromCodexId: "b",
      toCodexId: "a",
      relationType: "friend",
      directionality: "symmetric",
      forwardLabel: "友人",
      inverseLabel: null,
    });
    expect(ab).toBe(ba);
    expect(ab.startsWith("s\t")).toBe(true);
  });
});

describe("resolveCodexRelationVocabulary", () => {
  it("matches builtin vocabulary by forward label", () => {
    const resolved = resolveCodexRelationVocabulary({
      predicate: "友人",
      existingTypes: [],
      existingLabels: [],
      builtins: BUILTIN_CODEX_RELATION_VOCABULARY,
    });
    expect(resolved).toEqual({
      relationType: "friend",
      forwardLabel: "友人",
      inverseLabel: "友人",
      directionality: "symmetric",
      source: "builtin",
      ref: "builtin:friend",
    });
  });

  it("falls back to custom when nothing matches", () => {
    const resolved = resolveCodexRelationVocabulary({
      predicate: "監視している",
      existingTypes: ["mentor"],
      existingLabels: ["師匠"],
      builtins: BUILTIN_CODEX_RELATION_VOCABULARY,
    });
    expect(resolved).toEqual({
      relationType: "custom",
      forwardLabel: "監視している",
      inverseLabel: null,
      directionality: "directed",
      source: "custom",
      ref: "custom:監視している",
    });
  });

  it("prefers an existing project label/type match over builtin", () => {
    const resolved = resolveCodexRelationVocabulary({
      predicate: "師匠",
      existingTypes: ["sensei"],
      existingLabels: ["師匠"],
      builtins: BUILTIN_CODEX_RELATION_VOCABULARY,
    });
    expect(resolved.source).toBe("existing");
    expect(resolved.relationType).toBe("sensei");
    expect(resolved.forwardLabel).toBe("師匠");
  });
});
