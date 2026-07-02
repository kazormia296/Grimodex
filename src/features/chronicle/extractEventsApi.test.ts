import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.hoisted(() => vi.fn());
const mockBlock = vi.hoisted(() => vi.fn(() => false));
const mockRecord = vi.hoisted(() => vi.fn());
const mockOverride = vi.hoisted(() => vi.fn());
const mockCreateEvent = vi.hoisted(() => vi.fn());
const mockLinkScenes = vi.hoisted(() => vi.fn());
const mockListEvents = vi.hoisted(() => vi.fn());
const mockDeleteEvent = vi.hoisted(() => vi.fn());

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
vi.mock("./api", () => ({
  createEvent: mockCreateEvent,
  linkScenesToEvent: mockLinkScenes,
  listEvents: mockListEvents,
  deleteEvent: mockDeleteEvent,
}));

import {
  parseEventProposals,
  buildExtractEventsPrompt,
  proposeEvents,
  importExtractedEvents,
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
    const args = mockSend.mock.calls[0];
    expect(args[3]).toBe("chat_completions"); // apiVariant
    expect(args[5]).toBe("gpt-x"); // model
    expect(args[6]).toBe("openrouter"); // provider
    expect(args[7]).toBeNull(); // endpointId

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

describe("importExtractedEvents", () => {
  beforeEach(() => {
    mockCreateEvent.mockReset();
    mockCreateEvent.mockImplementation(async (d: { title: string }) => ({
      id: `ev-${d.title}`,
    }));
    mockLinkScenes.mockReset();
    mockLinkScenes.mockResolvedValue(undefined);
    mockListEvents.mockReset();
    mockListEvents.mockResolvedValue([]);
    mockDeleteEvent.mockReset();
    mockDeleteEvent.mockResolvedValue(undefined);
  });

  it("候補を events 化しシーンを結び、件数を返す", async () => {
    const n = await importExtractedEvents(
      "p1",
      [
        { title: "新事件A", evidenceSceneIds: ["s1", "s2"] },
        { title: "新事件B", evidenceSceneIds: [] },
      ],
      [],
    );
    expect(n).toBe(2);
    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    // 根拠シーンは出来事ごとに一括 link（A=2 シーン / B=空配列）
    expect(mockLinkScenes).toHaveBeenCalledTimes(2);
    expect(mockLinkScenes).toHaveBeenCalledWith(
      "p1",
      ["s1", "s2"],
      "ev-新事件A",
    );
    expect(mockLinkScenes).toHaveBeenCalledWith("p1", [], "ev-新事件B");
  });

  it("既存タイトルと重複する候補は正規化一致でスキップ（大小・前後空白を吸収）", async () => {
    const n = await importExtractedEvents(
      "p1",
      [
        { title: "新事件", evidenceSceneIds: ["s1"] },
        { title: "  Existing Event  ", evidenceSceneIds: ["s1"] }, // 重複
      ],
      ["existing event"],
    );
    expect(n).toBe(1);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "新事件" }),
    );
  });

  it("existingTitles 省略時は DB(listEvents) を参照して重複をスキップ", async () => {
    mockListEvents.mockResolvedValue([{ title: "既存" }]);
    const n = await importExtractedEvents("p1", [
      { title: "既存", evidenceSceneIds: ["s1"] }, // 重複
      { title: "新規", evidenceSceneIds: ["s1"] },
    ]);
    expect(n).toBe(1);
    expect(mockListEvents).toHaveBeenCalledTimes(1);
    expect(mockListEvents).toHaveBeenCalledWith("p1");
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "新規" }),
    );
  });

  it("同一バッチ内の重複は先勝ちで 1 件のみ作成", async () => {
    const n = await importExtractedEvents(
      "p1",
      [
        { title: "同じ", evidenceSceneIds: ["s1"] },
        { title: "同じ", evidenceSceneIds: ["s2"] },
      ],
      [],
    );
    expect(n).toBe(1);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
  });

  it("途中で失敗したら先行作成分を削除して部分適用を残さない", async () => {
    // A 成功 → B 失敗。C には到達しない。A は rollback 削除する。
    mockCreateEvent.mockReset();
    mockCreateEvent
      .mockResolvedValueOnce({ id: "ev-A" })
      .mockRejectedValueOnce(new Error("boom"));

    await expect(
      importExtractedEvents(
        "p1",
        [
          { title: "A", evidenceSceneIds: ["s1"] },
          { title: "B", evidenceSceneIds: ["s2"] },
          { title: "C", evidenceSceneIds: ["s3"] },
        ],
        [],
      ),
    ).rejects.toThrow("boom");

    // A=成功, B=失敗で停止, C=未試行
    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    // A の link のみ実行済み（B は createEvent で落ちるため link されない）
    expect(mockLinkScenes).toHaveBeenCalledTimes(1);
    expect(mockLinkScenes).toHaveBeenCalledWith("p1", ["s1"], "ev-A");
    expect(mockDeleteEvent).toHaveBeenCalledWith("ev-A", "p1");
  });
});
