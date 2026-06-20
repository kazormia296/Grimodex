import { describe, it, expect } from "vitest";
import {
  createRecallPromoteTracker,
  trackRecallForPromote,
  dismissRecallPromote,
  resetRecallPromote,
  CHAT_RECALL_PROMOTE_THRESHOLD,
} from "./chatRecallPromote";

const msg = (id: string) => ({ messageId: id, text: `t-${id}` });

describe("chatRecallPromote", () => {
  it("suggests only after the threshold of repeated recalls", () => {
    const s = createRecallPromoteTracker();
    for (let i = 1; i < CHAT_RECALL_PROMOTE_THRESHOLD; i++) {
      expect(trackRecallForPromote(s, [msg("m1")])).toBeNull();
    }
    const suggestion = trackRecallForPromote(s, [msg("m1")]);
    expect(suggestion).toEqual({ messageId: "m1", text: "t-m1" });
  });

  it("does not double-count the same message within one turn", () => {
    const s = createRecallPromoteTracker();
    // 同じ messageId が 1 ターンに 2 回来ても 1 回分。
    for (let i = 0; i < CHAT_RECALL_PROMOTE_THRESHOLD - 1; i++) {
      trackRecallForPromote(s, [msg("m1"), msg("m1")]);
    }
    // ここまで THRESHOLD-1 回分のカウント → まだ提案しない。
    expect(s.freq.get("m1")).toBe(CHAT_RECALL_PROMOTE_THRESHOLD - 1);
  });

  it("never re-suggests a dismissed message", () => {
    const s = createRecallPromoteTracker();
    dismissRecallPromote(s, "m1");
    for (let i = 0; i < CHAT_RECALL_PROMOTE_THRESHOLD + 5; i++) {
      expect(trackRecallForPromote(s, [msg("m1")])).toBeNull();
    }
  });

  it("returns the first eligible message when several cross at once", () => {
    const s = createRecallPromoteTracker();
    // m1, m2 を閾値-1 まで上げる。
    for (let i = 0; i < CHAT_RECALL_PROMOTE_THRESHOLD - 1; i++) {
      trackRecallForPromote(s, [msg("m1"), msg("m2")]);
    }
    const suggestion = trackRecallForPromote(s, [msg("m1"), msg("m2")]);
    expect(suggestion?.messageId).toBe("m1");
  });

  it("reset clears frequency and dismissals", () => {
    const s = createRecallPromoteTracker();
    dismissRecallPromote(s, "m1");
    trackRecallForPromote(s, [msg("m2")]);
    resetRecallPromote(s);
    expect(s.freq.size).toBe(0);
    expect(s.dismissed.size).toBe(0);
    // dismiss が消えたので m1 は再びカウント対象。
    for (let i = 1; i < CHAT_RECALL_PROMOTE_THRESHOLD; i++) {
      trackRecallForPromote(s, [msg("m1")]);
    }
    expect(trackRecallForPromote(s, [msg("m1")])?.messageId).toBe("m1");
  });
});
