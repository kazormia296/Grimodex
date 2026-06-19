import { describe, it, expect } from "vitest";
import type { ChatMessageSearchHit } from "../semantic-search/api";
import {
  chatRecallWeight,
  chatRecallLabel,
  selectChatRecallMessages,
  CHAT_RECALL_INSERTED_BOOST,
  CHAT_RECALL_EXTRACTED_BOOST,
  CHAT_RECALL_ASSISTANT_PLAIN_BASE,
} from "./chatRecall";

// ja のしきい値を明示的に渡し、env (document.lang) 依存を排除する。
const JA = { minScore: 0.8, gateScore: 0.85 };

function hit(
  over: Partial<ChatMessageSearchHit> & { messageId: string; score: number },
): ChatMessageSearchHit {
  return {
    sessionId: "s1",
    role: "user",
    text: `text-${over.messageId}`,
    insertedToEditor: false,
    extractedCount: 0,
    ...over,
  };
}

describe("chatRecallWeight", () => {
  it("user plain message has neutral weight 1", () => {
    expect(
      chatRecallWeight({
        role: "user",
        insertedToEditor: false,
        extractedCount: 0,
      }),
    ).toBe(1);
  });

  it("inserted-to-editor adds the inserted boost", () => {
    expect(
      chatRecallWeight({
        role: "user",
        insertedToEditor: true,
        extractedCount: 0,
      }),
    ).toBeCloseTo(1 + CHAT_RECALL_INSERTED_BOOST);
  });

  it("extracted count adds boost, capped", () => {
    expect(
      chatRecallWeight({
        role: "user",
        insertedToEditor: false,
        extractedCount: 2,
      }),
    ).toBeCloseTo(1 + 2 * CHAT_RECALL_EXTRACTED_BOOST);
    // cap at 3 — 5 件でも 3 件分まで。
    expect(
      chatRecallWeight({
        role: "user",
        insertedToEditor: false,
        extractedCount: 5,
      }),
    ).toBeCloseTo(1 + 3 * CHAT_RECALL_EXTRACTED_BOOST);
  });

  it("plain assistant prose is demoted below 1", () => {
    expect(
      chatRecallWeight({
        role: "assistant",
        insertedToEditor: false,
        extractedCount: 0,
      }),
    ).toBe(CHAT_RECALL_ASSISTANT_PLAIN_BASE);
  });

  it("assistant WITH a signal is not demoted (effective utterance)", () => {
    // hasSignal → roleBase 1.0、signalBoost のみ効く。
    expect(
      chatRecallWeight({
        role: "assistant",
        insertedToEditor: true,
        extractedCount: 0,
      }),
    ).toBeCloseTo(1 + CHAT_RECALL_INSERTED_BOOST);
  });
});

describe("chatRecallLabel", () => {
  it("distinguishes role", () => {
    expect(chatRecallLabel("assistant")).toContain("AI");
    expect(chatRecallLabel("user")).toContain("あなた");
  });
});

describe("selectChatRecallMessages (gate / weighting)", () => {
  it("injects a hit that clears the gate", () => {
    const out = selectChatRecallMessages(
      [hit({ messageId: "m1", score: 0.86 })],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out).toHaveLength(1);
    expect(out[0].messageId).toBe("m1");
    expect(out[0].role).toBe("user");
    expect(out[0].sessionId).toBe("s1");
  });

  it("injects nothing when the best hit is below the gate", () => {
    const out = selectChatRecallMessages(
      [hit({ messageId: "m1", score: 0.83 })],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out).toHaveLength(0);
  });

  it("weighting lifts an effective utterance over the gate", () => {
    // 生 cos 0.83 は gate 0.85 未満だが、insertedToEditor で 0.83×1.15=0.9545 → 注入。
    const out = selectChatRecallMessages(
      [hit({ messageId: "m1", score: 0.83, insertedToEditor: true })],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out).toHaveLength(1);
    expect(out[0].messageId).toBe("m1");
    expect(out[0].score).toBeGreaterThan(0.85);
  });

  it("plain assistant prose is demoted below the gate and dropped", () => {
    // 生 cos 0.86 は gate を越えるが、素の assistant は ×0.8 = 0.688 → 落ちる。
    const out = selectChatRecallMessages(
      [hit({ messageId: "m1", score: 0.86, role: "assistant" })],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out).toHaveLength(0);
  });

  it("excludes the current session (live turn) from recall", () => {
    const out = selectChatRecallMessages(
      [
        hit({ messageId: "live", score: 0.95, sessionId: "current" }),
        hit({ messageId: "past", score: 0.9, sessionId: "old" }),
      ],
      [],
      { excludeSessionIds: ["current"], ...JA },
    );
    expect(out.map((m) => m.messageId)).toEqual(["past"]);
  });

  it("routes through hybrid fusion when sparse messageIds are supplied", () => {
    // dense 勝者 (m1) がゲートを越え、sparse に居る m2 (floor 付近) が救済される。
    const out = selectChatRecallMessages(
      [
        hit({ messageId: "m1", score: 0.9 }),
        hit({ messageId: "m2", score: 0.81 }),
      ],
      ["m2"], // sparse 順位に m2
      { excludeSessionIds: [], ...JA },
    );
    const ids = out.map((m) => m.messageId);
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
  });

  it("excludes the current session even in hybrid mode", () => {
    const out = selectChatRecallMessages(
      [
        hit({ messageId: "live", score: 0.95, sessionId: "current" }),
        hit({ messageId: "past", score: 0.9, sessionId: "old" }),
      ],
      ["live", "past"], // sparse に両方
      { excludeSessionIds: ["current"], ...JA },
    );
    expect(out.map((m) => m.messageId)).not.toContain("live");
    expect(out.map((m) => m.messageId)).toContain("past");
  });

  it("preserves messageId/sessionId/role/text mapping back from selection", () => {
    const out = selectChatRecallMessages(
      [
        hit({
          messageId: "m1",
          score: 0.9,
          sessionId: "sX",
          role: "assistant",
          text: "決めたこと",
          insertedToEditor: true,
        }),
      ],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      messageId: "m1",
      sessionId: "sX",
      role: "assistant",
      text: "決めたこと",
    });
    expect(out[0].label).toContain("AI");
  });
});
