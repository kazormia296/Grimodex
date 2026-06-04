import { describe, expect, it, vi, beforeEach } from "vitest";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { DEFAULT_SETTINGS } from "@/features/settings/types";

const mockSendChatMessageWithThinking = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSendChatMessageWithThinking,
}));

import { proposePastSetups, type ProposeRequest } from "./api";

describe("proposePastSetups", () => {
  beforeEach(() => {
    mockSendChatMessageWithThinking.mockReset();
    useSettingsStore.setState({ cache: { ...DEFAULT_SETTINGS } });
  });

  it("returns parsed candidates from JSON response", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            sceneId: "scene-1",
            kind: "designated_existing",
            existingExcerpt: "古井戸の底に冷たい風が吹いた。",
            rationale: "井戸と終盤の秘密の接続を作れるため",
            predictedStrength: "subtle",
          },
        ],
      }),
      thinkingBlocks: [],
    });

    const req: ProposeRequest = {
      intent: "古井戸の秘密が後半で明かされる",
      payoffSceneId: "scene-9",
      payoffExcerpt: "井戸の底から王家の印章が見つかった。",
      pastScenes: [
        {
          sceneId: "scene-1",
          title: "第一章",
          excerpt: "古井戸の描写がある。",
          orderIndex: 1,
        },
      ],
      relatedCodex: [],
    };

    const result = await proposePastSetups(req);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sceneId: "scene-1",
      kind: "designated_existing",
      predictedStrength: "subtle",
    });
  });

  it("returns empty list when response is not valid JSON", async () => {
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: "候補はありません。",
      thinkingBlocks: [],
    });

    const req: ProposeRequest = {
      intent: "意図",
      payoffSceneId: "scene-9",
      payoffExcerpt: "本文",
      pastScenes: [],
      relatedCodex: [],
    };

    await expect(proposePastSetups(req)).resolves.toEqual([]);
  });

  it("includes foreshadow custom prompt instruction from settings", async () => {
    useSettingsStore.setState({
      cache: {
        ...DEFAULT_SETTINGS,
        "aiPrompt.custom.foreshadow": "小物描写を優先して伏線候補を作る",
      },
    });
    mockSendChatMessageWithThinking.mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
      thinkingBlocks: [],
    });

    const req: ProposeRequest = {
      intent: "意図",
      payoffSceneId: "scene-9",
      payoffExcerpt: "本文",
      pastScenes: [],
      relatedCodex: [],
    };

    await proposePastSetups(req);

    const calledWith = mockSendChatMessageWithThinking.mock.calls[0]?.[0];
    expect(calledWith).toBeDefined();
    const prompt = calledWith[0].content as string;
    expect(prompt).toContain("【追加指示】");
    expect(prompt).toContain("小物描写を優先して伏線候補を作る");
  });
});
