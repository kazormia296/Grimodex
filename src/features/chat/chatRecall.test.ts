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

  it("accepts injected weights (calibration sweep path)", () => {
    // 既定では plain assistant=0.8 だが、注入で 1.0 にすれば減点なし。
    const demoted = chatRecallWeight({
      role: "assistant",
      insertedToEditor: false,
      extractedCount: 0,
    });
    const noBase = chatRecallWeight(
      { role: "assistant", insertedToEditor: false, extractedCount: 0 },
      {
        insertedBoost: 0.15,
        extractedBoost: 0.1,
        extractedCap: 3,
        assistantPlainBase: 1.0,
      },
    );
    expect(demoted).toBe(0.8);
    expect(noBase).toBe(1.0);
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

  it("weighting does NOT lift a below-gate hit over the gate (precision-safe)", () => {
    // 較正で判明したバグの回帰: 生 cos 0.83 は gate 0.85 未満。信号付きでも weighted で
    // ゲートを突破させない(gate は RAW cosine)。無関連クエリの誤注入を防ぐ。
    const out = selectChatRecallMessages(
      [hit({ messageId: "m1", score: 0.83, insertedToEditor: true })],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out).toHaveLength(0);
  });

  it("weighting orders effective utterances ahead of plain ones within the gated set", () => {
    // 両方とも RAW で gate を越える。順位は重み付きスコアで決まる:
    //   plain user 0.90 → 0.90 / inserted assistant 0.87 → 0.87×1.15=1.0005 が上位。
    const out = selectChatRecallMessages(
      [
        hit({ messageId: "plain", score: 0.9, role: "user" }),
        hit({
          messageId: "effective",
          score: 0.87,
          role: "assistant",
          insertedToEditor: true,
        }),
      ],
      [],
      { excludeSessionIds: [], ...JA },
    );
    expect(out.map((m) => m.messageId)).toEqual(["effective", "plain"]);
  });

  it("a high-cosine plain assistant message is injected (gate on raw) but ranked last", () => {
    // 生 cos 0.86 は gate を越えるので注入される(raw ゲート)。素の assistant は
    // 重みで下位に回るが、precision のため除外はしない(話題的には関連)。
    const out = selectChatRecallMessages(
      [
        hit({ messageId: "user", score: 0.86, role: "user" }),
        hit({ messageId: "plainai", score: 0.88, role: "assistant" }),
      ],
      [],
      { excludeSessionIds: [], ...JA },
    );
    // plainai は raw 0.88 で最高だが、weighted 0.88×0.8=0.704 < user 0.86 → 下位。
    expect(out.map((m) => m.messageId)).toEqual(["user", "plainai"]);
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
