import { describe, expect, it } from "vitest";
import { createContextPlan } from "@/features/ai-context/types";
import { fullyInjectedCodexIdsFromPlan, type ChatContextItem } from "./types";

function pin(id: string, fullContent?: string): ChatContextItem {
  return {
    key: `codex:${id}`,
    kind: "codex",
    authority: "canonical",
    priority: 4,
    stability: "session-stable",
    trim: { mode: "atomic", minTokens: 0, maxTokens: 10 },
    provenance: { sourceType: "codex-pin", sourceId: id },
    payload: {
      kind: "codex",
      entry: {
        id,
        type: "character",
        name: id,
        summary: "summary",
        fullContent,
      },
      includePinnedExtras: true,
    },
  };
}

describe("fullyInjectedCodexIdsFromPlan", () => {
  it("includes only selected Spotlight items that still contain a full body", () => {
    const plan = createContextPlan({
      requestId: "request-1",
      items: [pin("selected", "full body"), pin("empty")],
      decisions: [
        {
          key: "codex:trimmed",
          status: "excluded",
          reason: "budget",
          tokensBefore: 10,
          tokensAfter: 0,
        },
      ],
      usage: {
        candidateTokens: 30,
        selectedTokens: 20,
        trimmedTokens: 10,
        budgetTokens: 20,
      },
    });

    expect(fullyInjectedCodexIdsFromPlan(plan)).toEqual(["selected"]);
  });
});
