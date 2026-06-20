import { describe, it, expect } from "vitest";
import type { ChatMessage } from "./chatTypes";
import {
  classifyMessagesForL5,
  shouldSummarize,
  selectSummarizationCandidates,
  isTier2Anchor,
  countTurns,
  getTier1Messages,
  computeL5UsedTokens,
} from "./conversationHistory";
import { parseChatMessageMetadata } from "./chatTypes";
import { countTokens } from "./contextBuilder";

function msg(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id,
    sessionId: "s1",
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("conversationHistory", () => {
  it("protects first user message and last 3 turn-pairs as Tier 1", () => {
    const messages = [
      msg("u1", "user", "first goal"),
      msg("a1", "assistant", "ok"),
      msg("u2", "user", "second"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "third"),
      msg("a3", "assistant", "reply3"),
      msg("u4", "user", "fourth"),
      msg("a4", "assistant", "reply4"),
    ];
    const { tier1, tier3 } = classifyMessagesForL5(messages, 8000);
    expect(tier1.map((m) => m.id)).toContain("u1");
    expect(tier1.map((m) => m.id)).toContain("u4");
    expect(tier1.map((m) => m.id)).toContain("a4");
    expect(tier3.map((m) => m.id)).not.toContain("u1");
  });

  it("treats insertedToEditor as Tier 2 anchor", () => {
    const messages = [
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "draft", {
        metadata: JSON.stringify({ insertedToEditor: true }),
      }),
    ];
    const meta = parseChatMessageMetadata(messages[1].metadata);
    expect(isTier2Anchor(messages[1], meta)).toBe(true);
    const { tier3 } = classifyMessagesForL5(messages, 8000);
    expect(tier3.map((m) => m.id)).not.toContain("a1");
  });

  it("selectSummarizationCandidates returns only Tier 3 assistant messages", () => {
    const messages = [
      msg("u1", "user", "start"),
      msg("a1", "assistant", "old filler"),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
      msg("u5", "user", "recent"),
      msg("a5", "assistant", "recent reply"),
    ];
    const candidates = selectSummarizationCandidates(messages, 8000);
    expect(candidates.every((m) => m.role === "assistant")).toBe(true);
    expect(candidates.map((m) => m.id)).toContain("a1");
    expect(candidates.map((m) => m.id)).not.toContain("a5");
  });

  it("shouldSummarize triggers preventive path at >4 turns and >80% budget", () => {
    const long = "x".repeat(4000);
    const messages = [
      msg("u1", "user", long),
      msg("a1", "assistant", long),
      msg("u2", "user", long),
      msg("a2", "assistant", long),
      msg("u3", "user", long),
      msg("a3", "assistant", long),
      msg("u4", "user", long),
      msg("a4", "assistant", long),
      msg("u5", "user", long),
      msg("a5", "assistant", long),
    ];
    expect(countTurns(messages)).toBe(5);
    const l5Budget = 1000;
    const l5Used = 900;
    expect(shouldSummarize(messages, l5Budget, l5Used)).toBe(true);
  });

  it("does not use isStarred for protection", () => {
    const messages = [
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "starred old", { isStarred: 1 }),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
    ];
    const candidates = selectSummarizationCandidates(messages, 8000);
    expect(candidates.map((m) => m.id)).toContain("a1");
  });
});

describe("countTurns — edge cases", () => {
  it("returns 0 for empty and system-only message lists", () => {
    expect(countTurns([])).toBe(0);
    expect(
      countTurns([
        msg("s1", "system", "you are an assistant"),
        msg("s2", "system", "more system"),
      ]),
    ).toBe(0);
  });

  it("floors odd non-system message counts and excludes system messages", () => {
    // 3 non-system messages -> floor(3/2) = 1 turn
    expect(
      countTurns([
        msg("u1", "user", "a"),
        msg("a1", "assistant", "b"),
        msg("u2", "user", "c"),
      ]),
    ).toBe(1);
    // system messages must not count toward the turn total
    expect(
      countTurns([
        msg("s1", "system", "sys"),
        msg("u1", "user", "a"),
        msg("a1", "assistant", "b"),
      ]),
    ).toBe(1);
  });
});

describe("isTier2Anchor — extracted-resource branches", () => {
  it("treats a non-empty extractedCodex array as a Tier 2 anchor", () => {
    const m = msg("a1", "assistant", "draft", {
      metadata: JSON.stringify({ extractedCodex: ["codex-1"] }),
    });
    expect(isTier2Anchor(m, parseChatMessageMetadata(m.metadata))).toBe(true);
  });

  it("treats a non-empty extractedSnippets array as a Tier 2 anchor", () => {
    const m = msg("a1", "assistant", "draft", {
      metadata: JSON.stringify({ extractedSnippets: ["snippet-1"] }),
    });
    expect(isTier2Anchor(m, parseChatMessageMetadata(m.metadata))).toBe(true);
  });

  it("does NOT treat empty extracted arrays as anchors", () => {
    const m = msg("a1", "assistant", "draft", {
      metadata: JSON.stringify({ extractedCodex: [], extractedSnippets: [] }),
    });
    expect(isTier2Anchor(m, parseChatMessageMetadata(m.metadata))).toBe(false);
  });

  it("a plain assistant message (no metadata) is not an anchor", () => {
    const m = msg("a1", "assistant", "plain reply");
    expect(isTier2Anchor(m, parseChatMessageMetadata(m.metadata))).toBe(false);
  });

  it("classifyMessagesForL5 keeps an extractedCodex assistant out of Tier 3", () => {
    const messages = [
      msg("u1", "user", "start"),
      msg("a1", "assistant", "extracted", {
        metadata: JSON.stringify({ extractedCodex: ["c1"] }),
      }),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
    ];
    const { tier2, tier3 } = classifyMessagesForL5(messages, 8000);
    expect(tier2.map((m) => m.id)).toContain("a1");
    expect(tier3.map((m) => m.id)).not.toContain("a1");
  });
});

describe("getTier1Messages — edge cases", () => {
  it("returns an empty array for an empty message list", () => {
    expect(getTier1Messages([])).toEqual([]);
  });

  it("returns an empty array when every message is summarized", () => {
    const messages = [
      msg("u1", "user", "old", { isSummarized: 1 }),
      msg("a1", "assistant", "old reply", { isSummarized: 1 }),
    ];
    expect(getTier1Messages(messages)).toEqual([]);
  });

  it("skips the first-user anchor when no user message exists", () => {
    // firstUserIdx < 0 branch: only assistant messages present.
    const messages = [
      msg("a1", "assistant", "r1"),
      msg("a2", "assistant", "r2"),
    ];
    expect(getTier1Messages(messages).map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("includes all messages when there are fewer than 3 recent turn-pairs", () => {
    const messages = [
      msg("u1", "user", "only goal"),
      msg("a1", "assistant", "only reply"),
    ];
    expect(getTier1Messages(messages).map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});

describe("classifyMessagesForL5 — Tier 2 sub-budget", () => {
  // 14 messages (7 pairs): tier1 = first user (u1) + last 6 (the final 3 pairs).
  // The 3 large insertedToEditor assistants below sit in the middle, so they are
  // Tier 2 candidates. Empty-content users are anchors too but cost 0 tokens.
  function conversationWithThreeLargeAnchors(): ChatMessage[] {
    const big = "Z".repeat(600); // heuristic ≈ 200 tokens each
    return [
      msg("u1", "user", "first goal"),
      msg("a1", "assistant", "filler"),
      msg("u2", "user", ""),
      msg("big-old", "assistant", big, {
        metadata: JSON.stringify({ insertedToEditor: true }),
      }),
      msg("u3", "user", ""),
      msg("big-mid", "assistant", big, {
        metadata: JSON.stringify({ insertedToEditor: true }),
      }),
      msg("u4", "user", ""),
      msg("big-new", "assistant", big, {
        metadata: JSON.stringify({ insertedToEditor: true }),
      }),
      msg("u5", "user", "m5"),
      msg("a5", "assistant", "r5"),
      msg("u6", "user", "m6"),
      msg("a6", "assistant", "r6"),
      msg("u7", "user", "m7"),
      msg("a7", "assistant", "r7"),
    ];
  }

  it("applies the 40% sub-budget newest-first and drops the oldest anchors over budget", () => {
    const messages = conversationWithThreeLargeAnchors();
    // tier2Budget = floor(1250 * 0.4) = 500 → fits 2 of 3 large (200 each) anchors.
    const { tier2 } = classifyMessagesForL5(messages, 1250);
    const ids = tier2.map((m) => m.id);
    expect(ids).toContain("big-new");
    expect(ids).toContain("big-mid");
    expect(ids).not.toContain("big-old"); // oldest large anchor dropped over budget
  });

  it("keeps at least one (the newest) anchor even when the sub-budget is zero", () => {
    const messages = conversationWithThreeLargeAnchors();
    // l5Budget 0 → tier2Budget 0 → the 'keep at least one' rule forces exactly the
    // newest candidate in, then the loop breaks.
    const { tier2 } = classifyMessagesForL5(messages, 0);
    expect(tier2).toHaveLength(1);
    expect(tier2[0].id).toBe("big-new");
  });

  it("excludes summarized messages from every tier", () => {
    const messages = [
      msg("u1", "user", "start"),
      msg("summarized-one", "assistant", "old summarized", { isSummarized: 1 }),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
    ];
    const { tier1, tier2, tier3 } = classifyMessagesForL5(messages, 8000);
    const all = [...tier1, ...tier2, ...tier3].map((m) => m.id);
    expect(all).not.toContain("summarized-one");
  });
});

describe("computeL5UsedTokens", () => {
  const messages = [
    msg("u1", "user", "first goal text"),
    msg("a1", "assistant", "an old assistant reply"),
    msg("u2", "user", "second message"),
    msg("a2", "assistant", "second reply"),
    msg("u3", "user", "third message"),
    msg("a3", "assistant", "third reply"),
    msg("u4", "user", "fourth message"),
    msg("a4", "assistant", "fourth reply"),
  ];

  it("sums summary tokens plus all classified message tokens", () => {
    const summaries = ["要約その一の本文", "要約その二の本文"];
    const l5Budget = 8000;
    const { tier1, tier2, tier3 } = classifyMessagesForL5(messages, l5Budget);
    const expectedMsg = [...tier1, ...tier2, ...tier3].reduce(
      (sum, m) => sum + countTokens(m.content),
      0,
    );
    const expectedSummary = summaries.reduce((s, x) => s + countTokens(x), 0);
    expect(computeL5UsedTokens(messages, summaries, l5Budget)).toBe(
      expectedSummary + expectedMsg,
    );
  });

  it("counts only message tokens when there are no summaries", () => {
    const l5Budget = 8000;
    const { tier1, tier2, tier3 } = classifyMessagesForL5(messages, l5Budget);
    const expectedMsg = [...tier1, ...tier2, ...tier3].reduce(
      (sum, m) => sum + countTokens(m.content),
      0,
    );
    expect(computeL5UsedTokens(messages, [], l5Budget)).toBe(expectedMsg);
  });
});

describe("shouldSummarize — guards and trigger paths", () => {
  function turns(n: number): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = 0; i < n; i++) {
      out.push(msg(`u${i}`, "user", `u${i}`));
      out.push(msg(`a${i}`, "assistant", `a${i}`));
    }
    return out;
  }

  it("never summarizes below EMERGENCY_MIN_TURNS (3) even when wildly over budget", () => {
    const messages = turns(2); // 2 turns < 3
    expect(shouldSummarize(messages, 100, 99_999)).toBe(false);
  });

  it("triggers the emergency path when usage exceeds budget (ratio > 1)", () => {
    const messages = turns(3); // meets the min-turn guard
    expect(shouldSummarize(messages, 1000, 1001)).toBe(true);
  });

  it("does NOT trigger at the exact preventive boundary (turns=4, ratio=0.8)", () => {
    const messages = turns(4); // 4 is not > PREVENTIVE_TURN_THRESHOLD (4)
    expect(shouldSummarize(messages, 1000, 800)).toBe(false); // ratio 0.8, not > 0.8
  });

  it("treats l5Budget=0 as ratio 1 (division guard) and fires preventively past 4 turns", () => {
    const messages = turns(5); // turns > 4
    expect(shouldSummarize(messages, 0, 0)).toBe(true);
  });
});

describe("selectSummarizationCandidates — boundary cases", () => {
  it("returns an empty array when there are no Tier 3 messages", () => {
    // 2 messages → both land in Tier 1, leaving Tier 3 empty.
    const messages = [msg("u1", "user", "hi"), msg("a1", "assistant", "yo")];
    expect(selectSummarizationCandidates(messages, 8000)).toEqual([]);
  });

  it("excludes already-summarized Tier 3 assistants", () => {
    const messages = [
      msg("u1", "user", "start"),
      msg("a1", "assistant", "old summarized reply", { isSummarized: 1 }),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
    ];
    const candidates = selectSummarizationCandidates(messages, 8000).map(
      (m) => m.id,
    );
    expect(candidates).not.toContain("a1");
  });
});
