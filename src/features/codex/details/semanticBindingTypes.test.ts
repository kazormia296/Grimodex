import { describe, expect, it } from "vitest";
import {
  DETAIL_BINDING_SOURCES,
  DETAIL_PROJECTION_KINDS,
  DETAIL_TEMPORAL_POLICIES,
  isDetailBindingSource,
  isDetailProjectionKind,
  isDetailTemporalPolicy,
  type DetailSemanticBinding,
  type PhaseDetailWrite,
  type ProjectedDetailValue,
} from "./semanticBindingTypes";

describe("semanticBindingTypes", () => {
  it("publishes the closed projection, temporal-policy, and source vocabularies", () => {
    expect(DETAIL_PROJECTION_KINDS).toEqual([
      "scalar-text",
      "summary-text",
      "enum",
      "entity-reference",
    ]);
    expect(DETAIL_TEMPORAL_POLICIES).toEqual([
      "base-only",
      "phase-on-durable-change",
      "base-and-phase",
      "derived",
      "manual-only",
    ]);
    expect(DETAIL_BINDING_SOURCES).toEqual(["preset", "user", "reviewed-ai"]);

    expect(Object.isFrozen(DETAIL_PROJECTION_KINDS)).toBe(true);
    expect(Object.isFrozen(DETAIL_TEMPORAL_POLICIES)).toBe(true);
    expect(Object.isFrozen(DETAIL_BINDING_SOURCES)).toBe(true);
  });

  it("narrows only exact persisted vocabulary values", () => {
    expect(isDetailProjectionKind("enum")).toBe(true);
    expect(isDetailProjectionKind("Enum")).toBe(false);
    expect(isDetailProjectionKind(1)).toBe(false);

    expect(isDetailTemporalPolicy("base-and-phase")).toBe(true);
    expect(isDetailTemporalPolicy("base_and_phase")).toBe(false);
    expect(isDetailTemporalPolicy(null)).toBe(false);

    expect(isDetailBindingSource("reviewed-ai")).toBe(true);
    expect(isDetailBindingSource("ai")).toBe(false);
    expect(isDetailBindingSource(undefined)).toBe(false);
  });

  it("keeps projected clear distinct from phase inherit", () => {
    const projected: readonly ProjectedDetailValue[] = [
      { kind: "text", text: "西部軍" },
      { kind: "enum", optionRef: "O001" },
      { kind: "entity", entityId: "entity:west-army" },
      { kind: "clear" },
    ];
    const writes: readonly PhaseDetailWrite[] = [
      { kind: "inherit" },
      { kind: "set", value: projected[0] },
      { kind: "clear" },
    ];

    expect(projected.map((value) => value.kind)).toEqual([
      "text",
      "enum",
      "entity",
      "clear",
    ]);
    expect(writes.map((write) => write.kind)).toEqual([
      "inherit",
      "set",
      "clear",
    ]);
  });

  it("represents a versioned definition-id binding independently of its name", () => {
    const binding = {
      id: "binding-1",
      projectId: "project-1",
      definitionId: "definition-1",
      facetKey: "role.current",
      projectionKind: "enum",
      temporalPolicy: "base-and-phase",
      source: "user",
      confirmed: true,
      version: 7,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    } satisfies DetailSemanticBinding;

    expect(binding).not.toHaveProperty("definitionName");
    expect(binding.definitionId).toBe("definition-1");
    expect(binding.version).toBe(7);
  });
});
