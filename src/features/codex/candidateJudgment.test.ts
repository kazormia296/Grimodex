import { describe, expect, it, vi } from "vitest";

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSend,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: vi.fn(() => false),
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/project/api", () => ({
  getProject: vi.fn().mockResolvedValue({ language: "ja" }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p1" }) },
}));

import {
  CandidateJudgmentRetiredError,
  judgeCandidates,
} from "./candidateJudgment";
import type { CodexCandidate } from "./candidateExtractor";

function cand(surface: string): CodexCandidate {
  return {
    surface,
    lemma: surface,
    count: 2,
    firstSceneId: "s1",
    context: "ctx",
  };
}

describe("judgeCandidates (retired)", () => {
  it("rejects without calling the model", async () => {
    await expect(judgeCandidates([cand("円明")], [])).rejects.toBeInstanceOf(
      CandidateJudgmentRetiredError,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never sends entry DB ids even when entries are provided", async () => {
    await expect(
      judgeCandidates([cand("円明")], [
        { id: "real-db-id", name: "円明", aliases: null },
      ]),
    ).rejects.toMatchObject({ code: "CODEX_JUDGMENT_RETIRED" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
