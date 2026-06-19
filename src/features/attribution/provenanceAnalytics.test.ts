import { describe, expect, it } from "vitest";
import {
  rollupModelContribution,
  rollupKindDistribution,
  rollupCostByModel,
  rollupCostByKind,
  buildProvenanceAnalytics,
  surfaceToProvenanceKind,
} from "./provenanceAnalytics";
import type { ResolvedPassage } from "./provenance";
import type { AiUsageCostRow } from "./aiUsageAnalytics";

// ── helpers ──────────────────────────────────────────────────────────────
const passage = (overrides: Partial<ResolvedPassage>): ResolvedPassage => ({
  id: "p-1",
  nodeId: "scene-1",
  from: 0,
  to: 10,
  charCount: 10,
  excerpt: "",
  model: "claude-sonnet-4-6",
  provenance: { kind: "inline-ai", model: "claude-sonnet-4-6" },
  ...overrides,
});

const usage = (overrides: Partial<AiUsageCostRow>): AiUsageCostRow => ({
  surface: "chat",
  model: "claude-sonnet-4-6",
  tokensIn: 1_000_000,
  tokensOut: 0,
  costUsd: null,
  ...overrides,
});

describe("rollupModelContribution", () => {
  it("sums chars and passage count per model across passages", () => {
    const rows = rollupModelContribution([
      passage({ model: "claude-sonnet-4-6", charCount: 10 }),
      passage({ model: "claude-sonnet-4-6", charCount: 5 }),
      passage({ model: "gpt-4o", charCount: 7 }),
    ]);
    expect(rows).toEqual([
      { model: "claude-sonnet-4-6", chars: 15, passages: 2 },
      { model: "gpt-4o", chars: 7, passages: 1 },
    ]);
  });

  it("falls back to provenance.model when span model is null, then sentinel", () => {
    const rows = rollupModelContribution([
      passage({ model: null, provenance: { kind: "chat", model: "chat-x" } }),
      passage({
        model: null,
        provenance: { kind: "orphan-chat", model: null },
      }),
    ]);
    // equal chars → sorted by model asc; "__unknown_model__" (underscore)
    // sorts before "chat-x".
    expect(rows).toEqual([
      { model: "__unknown_model__", chars: 10, passages: 1 },
      { model: "chat-x", chars: 10, passages: 1 },
    ]);
  });

  it("sorts by chars desc then model asc", () => {
    const rows = rollupModelContribution([
      passage({ model: "b-model", charCount: 5 }),
      passage({ model: "a-model", charCount: 5 }),
      passage({ model: "c-model", charCount: 20 }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["c-model", "a-model", "b-model"]);
  });

  it("returns empty for no passages", () => {
    expect(rollupModelContribution([])).toEqual([]);
  });
});

describe("rollupKindDistribution", () => {
  it("buckets char + passage counts by provenance kind", () => {
    const dist = rollupKindDistribution([
      passage({ provenance: { kind: "chat" }, charCount: 10 }),
      passage({ provenance: { kind: "chat" }, charCount: 5 }),
      passage({ provenance: { kind: "inline-ai" }, charCount: 8 }),
      passage({ provenance: { kind: "beat" }, charCount: 3 }),
      passage({ provenance: { kind: "orphan-chat" }, charCount: 2 }),
      passage({ provenance: { kind: "unknown" }, charCount: 1 }),
    ]);
    expect(dist.chat).toEqual({ chars: 15, passages: 2 });
    expect(dist.inlineAi).toEqual({ chars: 8, passages: 1 });
    expect(dist.beat).toEqual({ chars: 3, passages: 1 });
    expect(dist.orphanChat).toEqual({ chars: 2, passages: 1 });
    expect(dist.unknownAi).toEqual({ chars: 1, passages: 1 });
    expect(dist.totalChars).toBe(29);
    expect(dist.totalPassages).toBe(6);
  });

  it("is all-zero for empty input", () => {
    const dist = rollupKindDistribution([]);
    expect(dist.totalChars).toBe(0);
    expect(dist.totalPassages).toBe(0);
    expect(dist.chat).toEqual({ chars: 0, passages: 0 });
  });
});

describe("surfaceToProvenanceKind", () => {
  it("maps ai_usage surfaces onto provenance kinds", () => {
    expect(surfaceToProvenanceKind("chat")).toBe("chat");
    expect(surfaceToProvenanceKind("agent")).toBe("chat");
    expect(surfaceToProvenanceKind("inline_ai")).toBe("inline-ai");
    expect(surfaceToProvenanceKind("beat")).toBe("beat");
  });

  it("returns null for surfaces that do not map to body passages", () => {
    expect(surfaceToProvenanceKind("synopsis")).toBeNull();
    expect(surfaceToProvenanceKind("session_title")).toBeNull();
    expect(surfaceToProvenanceKind("map_branch")).toBeNull();
  });
});

describe("rollupCostByModel", () => {
  it("prefers provider cost, estimates when null, flags estimation", () => {
    const rows = rollupCostByModel([
      // provider-reported
      usage({ model: "gpt-4o", costUsd: 0.5 }),
      // estimated: 1M input tokens of sonnet ($3/M) = $3
      usage({ model: "claude-sonnet-4-6", tokensIn: 1_000_000, costUsd: null }),
    ]);
    const sonnet = rows.find((r) => r.model === "claude-sonnet-4-6")!;
    const gpt = rows.find((r) => r.model === "gpt-4o")!;
    expect(gpt.costUsd).toBeCloseTo(0.5, 6);
    expect(gpt.estimated).toBe(false);
    expect(sonnet.costUsd).toBeCloseTo(3, 6);
    expect(sonnet.estimated).toBe(true);
    expect(sonnet.calls).toBe(1);
  });

  it("sums multiple rows of the same model and sorts by cost desc", () => {
    const rows = rollupCostByModel([
      usage({ model: "m", costUsd: 1 }),
      usage({ model: "m", costUsd: 2 }),
      usage({ model: "n", costUsd: 0.1 }),
    ]);
    expect(rows[0]).toMatchObject({ model: "m", costUsd: 3, calls: 2 });
    expect(rows[1].model).toBe("n");
  });

  it("uses a sentinel for null model", () => {
    const rows = rollupCostByModel([usage({ model: null, costUsd: 0.2 })]);
    expect(rows[0].model).toBe("__unknown_model__");
  });
});

describe("rollupCostByKind", () => {
  it("maps surfaces to kinds and ignores unmapped surfaces", () => {
    const res = rollupCostByKind([
      usage({ surface: "chat", costUsd: 1 }),
      usage({ surface: "agent", costUsd: 2 }), // → chat bucket
      usage({ surface: "inline_ai", costUsd: 0.5 }),
      usage({ surface: "beat", costUsd: 0.25 }),
      usage({ surface: "synopsis", costUsd: 9 }), // unmapped → "other"
    ]);
    expect(res.byKind.chat.costUsd).toBeCloseTo(3, 6);
    expect(res.byKind.inlineAi.costUsd).toBeCloseTo(0.5, 6);
    expect(res.byKind.beat.costUsd).toBeCloseTo(0.25, 6);
    expect(res.otherCostUsd).toBeCloseTo(9, 6);
    expect(res.totalCostUsd).toBeCloseTo(12.75, 6);
  });

  it("propagates estimated flag when any contributing row is estimated", () => {
    const res = rollupCostByKind([
      usage({ surface: "chat", model: "claude-sonnet-4-6", costUsd: null }),
    ]);
    expect(res.anyEstimated).toBe(true);
    expect(res.byKind.chat.estimated).toBe(true);
  });
});

describe("buildProvenanceAnalytics", () => {
  it("composes the three rollups into one report", () => {
    const report = buildProvenanceAnalytics(
      [
        passage({ model: "claude-sonnet-4-6", charCount: 10 }),
        passage({
          provenance: { kind: "chat", model: "chat-x" },
          model: "chat-x",
          charCount: 4,
        }),
      ],
      [
        usage({ surface: "chat", costUsd: 1 }),
        usage({ surface: "inline_ai", model: "gpt-4o", costUsd: 0.2 }),
      ],
    );
    expect(report.modelContribution.length).toBe(2);
    expect(report.kindDistribution.totalChars).toBe(14);
    expect(report.costByModel.length).toBe(2);
    expect(report.costByKind.totalCostUsd).toBeCloseTo(1.2, 6);
    expect(report.hasUsageData).toBe(true);
  });

  it("flags absent usage data so the UI can hide the cost lane", () => {
    const report = buildProvenanceAnalytics([passage({})], []);
    expect(report.hasUsageData).toBe(false);
    expect(report.costByModel).toEqual([]);
    expect(report.costByKind.totalCostUsd).toBe(0);
  });
});
