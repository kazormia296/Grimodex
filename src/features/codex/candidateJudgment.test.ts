import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSend = vi.hoisted(() => vi.fn());
const mockBlock = vi.hoisted(() => vi.fn(() => false));
const mockHidden = vi.hoisted(() => vi.fn());

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
// hidden の判定（実物の DB を通す試験は candidateJudgment.realHidden.test.ts）。
vi.mock("./context/codexHiddenAnyPhase", () => ({
  listCodexIdsHiddenFromAiInAnyPhase: mockHidden,
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
    mockHidden.mockReset();
    mockHidden.mockResolvedValue(new Set<string>());
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

  it("壊れた AI 出力は失敗として通知できるよう reject する", async () => {
    mockSend.mockResolvedValue({
      text: "no json here",
      inputTokens: 0,
      outputTokens: 0,
    });
    await expect(judgeCandidates([cand("円明")], [])).rejects.toMatchObject({
      code: "CODEX_JUDGMENT_NO_VALID_RESULT",
    });
  });

  it("transport 失敗を空 Map にせず呼び出し元へ伝える", async () => {
    mockSend.mockRejectedValue(new Error("transport unavailable"));

    await expect(judgeCandidates([cand("円明")], [])).rejects.toThrow(
      "transport unavailable",
    );
  });

  it("hidden の判定に失敗したら AI を呼ばず reject する（fail-closed）", async () => {
    aiReturns([]);
    mockHidden.mockRejectedValue(new Error("db unavailable"));

    await expect(
      judgeCandidates(
        [cand("円明")],
        [{ id: "e1", name: "首都", aliases: null }],
      ),
    ).rejects.toMatchObject({ code: "CODEX_JUDGMENT_HIDDEN_CHECK_FAILED" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("hidden を除いた後で先頭 200 件の窓を数える（hidden が窓を占めても公開の項目が落ちない）", async () => {
    aiReturns([
      {
        surface: "円明",
        suggestedType: "character",
        summary: "",
        aliasOfId: null,
      },
    ]);
    // 先頭 150 件が hidden、続く 100 件が公開。除く前に 200 件で切ると公開は 50 件しか残らない。
    const all = Array.from({ length: 250 }, (_, i) => ({
      id: `id-${String(i).padStart(3, "0")}-x`,
      name: `名前${String(i).padStart(3, "0")}`,
      aliases: null,
    }));
    mockHidden.mockResolvedValue(new Set(all.slice(0, 150).map((e) => e.id)));

    await judgeCandidates([cand("円明")], all);

    const prompt = (
      mockSend.mock.calls[0][0] as Array<{ content: string }>
    )[0].content.toString();
    for (const e of all.slice(0, 150)) expect(prompt).not.toContain(e.id);
    // 公開 100 件は全部入る（窓 200 に収まる）。
    for (const e of all.slice(150)) expect(prompt).toContain(e.id);
  });

  it("hidden の id を AI が aliasOfId に返しても採用しない（knownIds は除いた後の一覧）", async () => {
    aiReturns([
      {
        surface: "円明",
        suggestedType: "character",
        summary: "",
        aliasOfId: "secret-id",
      },
    ]);
    mockHidden.mockResolvedValue(new Set(["secret-id"]));

    const m = await judgeCandidates(
      [cand("円明")],
      [
        { id: "secret-id", name: "秘匿", aliases: null },
        { id: "e1", name: "公開", aliases: null },
      ],
    );

    expect(m.get("円明")?.aliasOfId).toBeNull();
  });

  it("候補の表記が hidden の項目の名前・別名・lemma と同じなら、その候補は送らず、全部該当するなら AI を呼ばない", async () => {
    mockHidden.mockResolvedValue(new Set(["secret-id"]));
    const entries = [
      { id: "secret-id", name: "秘匿の帝都", aliases: '["影の都ヴォルグ"]' },
      { id: "e1", name: "公開", aliases: null },
    ];

    expect(await judgeCandidates([cand("影の都ヴォルグ")], entries)).toEqual(
      new Map(),
    );
    expect(mockSend).not.toHaveBeenCalled();

    aiReturns([]);
    await judgeCandidates(
      [
        cand("影の都ヴォルグ"),
        { ...cand("活用形"), lemma: "秘匿の帝都" },
        cand("円明"),
      ],
      entries,
    ).catch(() => undefined);
    const prompt = (
      mockSend.mock.calls[0][0] as Array<{ content: string }>
    )[0].content.toString();
    expect(prompt).not.toContain("影の都ヴォルグ");
    expect(prompt).not.toContain("活用形");
    expect(prompt).toContain("円明");
  });
});
