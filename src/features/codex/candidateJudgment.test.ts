import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSend = vi.hoisted(() => vi.fn());
const mockBlock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSend,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlock,
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

import { judgeCandidates } from "./candidateJudgment";
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

function aiReturns(judgments: unknown[]) {
  mockSend.mockResolvedValue({
    text: JSON.stringify({ judgments }),
    inputTokens: 1,
    outputTokens: 1,
  });
}

describe("judgeCandidates", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockBlock.mockReturnValue(false);
  });

  it("種別を正規化採用し、不正種別は捨て、未知 aliasOfId は null に倒す", async () => {
    aiReturns([
      {
        surface: "円明",
        suggestedType: " Character ",
        summary: "主人公",
        aliasOfId: null,
      },
      {
        surface: "帝都",
        suggestedType: "location",
        summary: "",
        aliasOfId: "e1",
      },
      { surface: "謎", suggestedType: "bogus", summary: "", aliasOfId: null },
      { surface: "影", suggestedType: "item", summary: "", aliasOfId: "ghost" },
    ]);
    const m = await judgeCandidates(
      [cand("円明"), cand("帝都"), cand("謎"), cand("影")],
      [{ id: "e1", name: "首都", aliases: null }],
    );
    // 前後空白・大小を吸収して enum に丸める
    expect(m.get("円明")?.suggestedType).toBe("character");
    expect(m.get("円明")?.summary).toBe("主人公");
    expect(m.get("帝都")?.aliasOfId).toBe("e1"); // 既知 id は採用
    expect(m.has("謎")).toBe(false); // 不正な種別は除外
    // 種別は有効・aliasOfId だけ未知 → 判定は活かし alias は null に倒す
    expect(m.get("影")?.suggestedType).toBe("item");
    expect(m.get("影")?.aliasOfId).toBeNull();
  });

  it("入力候補に無い surface (hallucination) と空白のみ surface は捨てる", async () => {
    aiReturns([
      {
        surface: "円明",
        suggestedType: "character",
        summary: "",
        aliasOfId: null,
      },
      {
        surface: "パン屋",
        suggestedType: "location",
        summary: "",
        aliasOfId: null,
      },
      { surface: "   ", suggestedType: "item", summary: "", aliasOfId: null },
    ]);
    const m = await judgeCandidates([cand("円明")], []);
    expect(m.has("円明")).toBe(true);
    expect(m.has("パン屋")).toBe(false); // 入力に無い
    expect(m.size).toBe(1); // 空白 surface も入らない
  });

  it("policy off なら AI を呼ばず空", async () => {
    mockBlock.mockReturnValue(true);
    const m = await judgeCandidates([cand("円明")], []);
    expect(m.size).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("候補ゼロなら AI を呼ばない", async () => {
    const m = await judgeCandidates([], []);
    expect(m.size).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("壊れた AI 出力では空 Map", async () => {
    mockSend.mockResolvedValue({
      text: "no json here",
      inputTokens: 0,
      outputTokens: 0,
    });
    const m = await judgeCandidates([cand("円明")], []);
    expect(m.size).toBe(0);
  });
});
