import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.hoisted(() => vi.fn());
const mockBlock = vi.hoisted(() => vi.fn(() => false));
const mockRecord = vi.hoisted(() => vi.fn());
const mockOverride = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSend,
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: mockOverride,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: mockRecord,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlock,
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ get: () => "" }) },
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p1" }) },
}));
import {
  parseEventProposals,
  parseEventProposalsResult,
  buildExtractEventsPrompt,
  proposeEvents,
} from "./extractEventsApi";

const allowed = new Set(["s1", "s2"]);

describe("parseEventProposals", () => {
  it("JSON(コードフェンス可)から title＋許可 scene 参照のみ抽出", () => {
    const text =
      '```json\n{"events":[{"title":"王の崩御","evidenceSceneIds":["s1","ghost"],"note":"重要"}]}\n```';
    const out = parseEventProposals(text, allowed);
    expect(out).toEqual([
      { title: "王の崩御", evidenceSceneIds: ["s1"], note: "重要" },
    ]);
  });

  it("title 空 / events 非配列 は除外", () => {
    expect(
      parseEventProposals(
        '{"events":[{"title":"  ","evidenceSceneIds":["s1"]}]}',
        allowed,
      ),
    ).toEqual([]);
    expect(parseEventProposals('{"events":"x"}', allowed)).toEqual([]);
  });

  it("evidenceSceneIds は重複排除・全て不正なら空配列で残す", () => {
    const out = parseEventProposals(
      '{"events":[{"title":"会議","evidenceSceneIds":["s2","s2","bad"]}]}',
      allowed,
    );
    expect(out).toEqual([{ title: "会議", evidenceSceneIds: ["s2"] }]);
  });

  it("壊れた JSON は空", () => {
    expect(parseEventProposals("not json", allowed)).toEqual([]);
  });

  it("評価経路では正常0件と parse failure を区別する", () => {
    expect(parseEventProposalsResult('{"events":[]}', allowed)).toEqual({
      status: "parsed",
      proposals: [],
      diagnostics: [],
    });
    expect(parseEventProposalsResult("not json", allowed)).toEqual({
      status: "invalid",
      reason: "json-not-found",
    });
    expect(parseEventProposalsResult('{"events":"x"}', allowed)).toEqual({
      status: "invalid",
      reason: "events-not-array",
    });
  });

  it("評価経路では未知 scene と evidence 全滅を診断する", () => {
    expect(
      parseEventProposalsResult(
        '{"events":[{"title":"会議","evidenceSceneIds":["ghost"]}]}',
        allowed,
      ),
    ).toEqual({
      status: "parsed",
      proposals: [{ title: "会議", evidenceSceneIds: [] }],
      diagnostics: [
        {
          code: "unknown-scene-reference",
          eventIndex: 0,
          value: "ghost",
        },
        { code: "missing-evidence", eventIndex: 0 },
      ],
    });
  });
});

describe("buildExtractEventsPrompt", () => {
  it("scene 本文と id・カスタム指示をプロンプトに含む", () => {
    const p = buildExtractEventsPrompt({
      scenes: [
        { sceneId: "s1", title: "場面1", bodyText: "本文A", orderIndex: 0 },
      ],
      existingTitles: ["既存出来事"],
      customInstruction: "簡潔に",
    });
    expect(p).toContain("s1");
    expect(p).toContain("本文A");
    expect(p).toContain("既存出来事");
    expect(p).toContain("簡潔に");
    // 期待する JSON 形を明示している
    expect(p).toContain("evidenceSceneIds");
  });
});

describe("proposeEvents", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockBlock.mockReset();
    mockBlock.mockReturnValue(false);
    mockRecord.mockReset();
    mockRecord.mockResolvedValue(undefined);
    mockOverride.mockReset();
    mockOverride.mockReturnValue({
      model: "gpt-x",
      provider: "openrouter",
      apiVariant: "chat_completions",
      endpointId: null,
    });
  });

  it("policy off なら送信も記録もせず空", async () => {
    mockBlock.mockReturnValue(true);
    const out = await proposeEvents({
      scenes: [
        { sceneId: "s1", title: "場面", bodyText: "本文", orderIndex: 0 },
      ],
      existingTitles: [],
    });
    expect(out).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("本文が空のシーンだけなら短絡して送信しない", async () => {
    const out = await proposeEvents({
      scenes: [
        { sceneId: "s1", title: "空1", bodyText: "   ", orderIndex: 0 },
        { sceneId: "s2", title: "空2", bodyText: "", orderIndex: 1 },
      ],
      existingTitles: [],
    });
    expect(out).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("override の model/provider で送信し、usage を 1 回そのモデルで記録、allowedSceneIds は本文ありシーンのみ", async () => {
    // s2 は本文空 → allowedSceneIds から外れ、参照は落ちる。ghost は元から許可外。
    mockSend.mockResolvedValue({
      text: JSON.stringify({
        events: [{ title: "決戦", evidenceSceneIds: ["s1", "s2", "ghost"] }],
      }),
      inputTokens: 12,
      outputTokens: 34,
    });

    const out = await proposeEvents({
      scenes: [
        { sceneId: "s1", title: "場面1", bodyText: "本文A", orderIndex: 0 },
        { sceneId: "s2", title: "場面2", bodyText: "  ", orderIndex: 1 },
      ],
      existingTitles: ["既存"],
    });

    // 許可シーンは本文ありの s1 のみ（s2/ghost は除外）
    expect(out).toEqual([{ title: "決戦", evidenceSceneIds: ["s1"] }]);

    // 送信は 1 回・override 引数が正しい位置で渡る
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockOverride).toHaveBeenCalledWith("chronicle_extract");
    const args = mockSend.mock.calls[0];
    expect(args[1]).toEqual(
      expect.objectContaining({ projectId: "p1", pathId: "chronicle_extract" }),
    );
    expect(args[4]).toBe("chat_completions"); // apiVariant
    expect(args[6]).toBe("gpt-x"); // model
    expect(args[7]).toBe("openrouter"); // provider
    expect(args[8]).toBeNull(); // endpointId

    // usage は override のモデル/プロバイダで 1 回だけ記録
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chronicle_extract",
        model: "gpt-x",
        provider: "openrouter",
        tokensIn: 12,
        tokensOut: 34,
      }),
    );
  });
});
