import { describe, expect, it } from "vitest";
import {
  computeContextPlanDigest,
  createContextPlan,
  type ContextItem,
} from "./types";

interface TestPayload {
  label: string;
  nested: Record<string, number>;
}

function item(
  key: string,
  payload: TestPayload,
): ContextItem<TestPayload, "test"> {
  return {
    key,
    kind: "test",
    authority: "canonical",
    priority: 2,
    stability: "turn-volatile",
    trim: { mode: "atomic", minTokens: 0, maxTokens: 100 },
    provenance: { sourceType: "fixture", sourceId: key },
    payload,
  };
}

describe("ContextPlan digest", () => {
  it("is deterministic across equivalent object key insertion orders", () => {
    const first = createContextPlan({
      requestId: "request-1",
      items: [item("one", { label: "A", nested: { z: 2, a: 1 } })],
      decisions: [
        {
          key: "one",
          status: "selected",
          reason: "within-budget",
          tokensBefore: 4,
          tokensAfter: 4,
        },
      ],
      usage: {
        candidateTokens: 4,
        selectedTokens: 4,
        trimmedTokens: 0,
        budgetTokens: null,
      },
    });
    const second = createContextPlan({
      requestId: "request-1",
      items: [item("one", { label: "A", nested: { a: 1, z: 2 } })],
      decisions: [
        {
          key: "one",
          status: "selected",
          reason: "within-budget",
          tokensBefore: 4,
          tokensAfter: 4,
        },
      ],
      usage: {
        candidateTokens: 4,
        selectedTokens: 4,
        trimmedTokens: 0,
        budgetTokens: null,
      },
    });

    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^ctx-[0-9a-f]{8}$/);
  });

  it("changes when semantic item order changes", () => {
    const one = item("one", { label: "A", nested: {} });
    const two = item("two", { label: "B", nested: {} });
    const base = {
      requestId: "request-1",
      decisions: [],
      usage: {
        candidateTokens: 0,
        selectedTokens: 0,
        trimmedTokens: 0,
        budgetTokens: null,
      },
    } as const;

    expect(computeContextPlanDigest({ ...base, items: [one, two] })).not.toBe(
      computeContextPlanDigest({ ...base, items: [two, one] }),
    );
  });

  it("snapshots and freezes item payloads so the digest cannot go stale", () => {
    const payload = { label: "A", nested: { value: 1 } };
    const plan = createContextPlan({
      requestId: "request-immutable",
      items: [item("one", payload)],
      decisions: [],
      usage: {
        candidateTokens: 1,
        selectedTokens: 1,
        trimmedTokens: 0,
        budgetTokens: null,
      },
    });
    const digest = plan.digest;

    payload.label = "mutated outside";
    payload.nested.value = 2;

    expect(plan.items[0]?.payload).toEqual({
      label: "A",
      nested: { value: 1 },
    });
    expect(plan.digest).toBe(digest);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.items[0]?.payload.nested)).toBe(true);
  });

  it.each([
    ["Date", new Date("2026-01-01T00:00:00.000Z")],
    ["Map", new Map([["key", "value"]])],
    ["Set", new Set(["value"])],
  ])("rejects mutable built-in payloads (%s)", (_label, payload) => {
    expect(() =>
      createContextPlan({
        requestId: "request-mutable-built-in",
        items: [
          {
            ...item("one", { label: "A", nested: {} }),
            payload,
          },
        ],
        decisions: [],
        usage: {
          candidateTokens: 1,
          selectedTokens: 1,
          trimmedTokens: 0,
          budgetTokens: null,
        },
      }),
    ).toThrow("immutable JSON-like payload values");
  });
});
