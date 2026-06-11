import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChapterAuditRequest } from "./types";

const mockSendChatMessageWithThinking = vi.hoisted(() => vi.fn());
const mockBlockIfPolicyOff = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSendChatMessageWithThinking,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlockIfPolicyOff,
}));

import { proposePastSetups, evaluateSetupStrength, auditChapter } from "./api";
import type { ProposeRequest } from "./api";

const PROPOSE_REQ: ProposeRequest = {
  intent: "意図",
  payoffSceneId: "scene-9",
  payoffExcerpt: "本文",
  pastScenes: [],
  relatedCodex: [],
};

const AUDIT_REQ: ChapterAuditRequest = {
  chapterId: "ch-1",
  scenes: [
    { sceneId: "scene-1", title: "第1話", bodyText: "本文。", orderIndex: 0 },
  ],
  existingForeshadows: [],
  relatedCodex: [],
};

describe("foreshadow api — AiPolicy (analysis) gate", () => {
  beforeEach(() => {
    mockSendChatMessageWithThinking.mockReset();
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
      thinkingBlocks: [],
    });
    mockBlockIfPolicyOff.mockReset();
    mockBlockIfPolicyOff.mockReturnValue(false);
  });

  it("proposePastSetups: analysis=off なら LLM を呼ばず [] を返す", async () => {
    mockBlockIfPolicyOff.mockReturnValue(true);
    await expect(proposePastSetups(PROPOSE_REQ)).resolves.toEqual([]);
    expect(mockBlockIfPolicyOff).toHaveBeenCalledWith("analysis");
    expect(mockSendChatMessageWithThinking).not.toHaveBeenCalled();
  });

  it("evaluateSetupStrength: analysis=off なら LLM を呼ばず null を返す", async () => {
    mockBlockIfPolicyOff.mockReturnValue(true);
    await expect(
      evaluateSetupStrength({
        setupId: "s-1",
        setupExcerpt: "抜粋",
        foreshadowIntent: "意図",
      }),
    ).resolves.toBeNull();
    expect(mockBlockIfPolicyOff).toHaveBeenCalledWith("analysis");
    expect(mockSendChatMessageWithThinking).not.toHaveBeenCalled();
  });

  it("auditChapter: analysis=off なら LLM を呼ばず [] を返す", async () => {
    mockBlockIfPolicyOff.mockReturnValue(true);
    await expect(auditChapter(AUDIT_REQ)).resolves.toEqual([]);
    expect(mockBlockIfPolicyOff).toHaveBeenCalledWith("analysis");
    expect(mockSendChatMessageWithThinking).not.toHaveBeenCalled();
  });

  it("許可時は 3 関数とも LLM 呼び出しへ進む", async () => {
    await proposePastSetups(PROPOSE_REQ);
    await evaluateSetupStrength({
      setupId: "s-1",
      setupExcerpt: "抜粋",
      foreshadowIntent: "意図",
    });
    await auditChapter(AUDIT_REQ);
    expect(mockSendChatMessageWithThinking).toHaveBeenCalledTimes(3);
  });
});
