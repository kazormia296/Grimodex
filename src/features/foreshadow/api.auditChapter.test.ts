import { describe, expect, it, vi, beforeEach } from "vitest";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { DEFAULT_SETTINGS } from "@/features/settings/types";

const mockSendChatMessageWithThinking = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSendChatMessageWithThinking,
}));

import { auditChapter, type ChapterAuditRequest } from "./api";

const BASE_REQ: ChapterAuditRequest = {
  chapterId: "ch-1",
  scenes: [
    {
      sceneId: "scene-1",
      title: "第一話",
      bodyText: "赤いスカーフが風にはためいた。少女は何も言わず立ち去った。",
      orderIndex: 1,
    },
    {
      sceneId: "scene-2",
      title: "第二話",
      bodyText: "王の指輪が机の上に置き去りにされていた。",
      orderIndex: 2,
    },
  ],
  existingForeshadows: [],
  relatedCodex: [],
};

describe("auditChapter", () => {
  beforeEach(() => {
    mockSendChatMessageWithThinking.mockReset();
    useSettingsStore.setState({ cache: { ...DEFAULT_SETTINGS } });
  });

  it("returns parsed audit candidates from JSON response", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            suggestedTitle: "赤いスカーフの伏線",
            suggestedIntent: "スカーフが後半で重要な証拠になる",
            evidenceSceneId: "scene-1",
            evidenceExcerpt: "赤いスカーフが風にはためいた",
            rationale: "繰り返し登場する可能性のある具体的なディテール",
            confidence: "medium",
          },
        ],
      }),
      thinkingBlocks: [],
    });

    const result = await auditChapter(BASE_REQ);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      suggestedTitle: "赤いスカーフの伏線",
      evidenceSceneId: "scene-1",
      confidence: "medium",
    });
  });

  it("returns empty list when response is not valid JSON", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: "候補はありません",
      thinkingBlocks: [],
    });

    await expect(auditChapter(BASE_REQ)).resolves.toEqual([]);
  });

  it("excludes candidates with invalid confidence values", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            suggestedTitle: "valid",
            suggestedIntent: "意図",
            evidenceSceneId: "scene-1",
            evidenceExcerpt: "引用",
            rationale: "理由",
            confidence: "medium",
          },
          {
            suggestedTitle: "invalid",
            suggestedIntent: "意図",
            evidenceSceneId: "scene-1",
            evidenceExcerpt: "引用",
            rationale: "理由",
            confidence: "unknown", // invalid
          },
        ],
      }),
      thinkingBlocks: [],
    });

    const result = await auditChapter(BASE_REQ);
    expect(result).toHaveLength(1);
    expect(result[0].suggestedTitle).toBe("valid");
  });

  it("excludes empty bodyText scenes from AI input", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
      thinkingBlocks: [],
    });

    const req: ChapterAuditRequest = {
      ...BASE_REQ,
      scenes: [
        {
          sceneId: "empty-scene",
          title: "空シーン",
          bodyText: "",
          orderIndex: 1,
        },
        {
          sceneId: "scene-1",
          title: "有シーン",
          bodyText: "本文あり",
          orderIndex: 2,
        },
      ],
    };

    await auditChapter(req);

    const calledWith = mockSendChatMessageWithThinking.mock.calls[0]?.[0];
    expect(calledWith).toBeDefined();
    const prompt = calledWith[0].content as string;
    expect(prompt).not.toContain("empty-scene");
    expect(prompt).toContain("scene-1");
  });

  it("does not call AI when all scenes have empty bodyText", async () => {
    const req: ChapterAuditRequest = {
      ...BASE_REQ,
      scenes: [
        { sceneId: "s-1", title: "空1", bodyText: "", orderIndex: 1 },
        { sceneId: "s-2", title: "空2", bodyText: "   ", orderIndex: 2 },
      ],
    };

    const result = await auditChapter(req);

    expect(mockSendChatMessageWithThinking).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("includes similarToExistingForeshadowId in output when present", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            suggestedTitle: "類似候補",
            suggestedIntent: "意図",
            evidenceSceneId: "scene-1",
            evidenceExcerpt: "引用",
            rationale: "理由",
            confidence: "low",
            similarToExistingForeshadowId: "existing-fid",
          },
        ],
      }),
      thinkingBlocks: [],
    });

    const result = await auditChapter(BASE_REQ);
    expect(result[0].similarToExistingForeshadowId).toBe("existing-fid");
  });

  it("includes foreshadow custom prompt instruction from settings", async () => {
    useSettingsStore.setState({
      cache: {
        ...DEFAULT_SETTINGS,
        "aiPrompt.custom.foreshadow": "伏線候補は過剰な説明を避ける",
      },
    });
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
      thinkingBlocks: [],
    });

    await auditChapter(BASE_REQ);

    const calledWith = mockSendChatMessageWithThinking.mock.calls[0]?.[0];
    expect(calledWith).toBeDefined();
    const prompt = calledWith[0].content as string;
    expect(prompt).toContain("【追加指示】");
    expect(prompt).toContain("伏線候補は過剰な説明を避ける");
  });
});
