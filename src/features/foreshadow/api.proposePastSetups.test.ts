import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSendChatMessageWithThinking = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: mockSendChatMessageWithThinking,
}));

import { proposePastSetups, type ProposeRequest } from "./api";

describe("proposePastSetups", () => {
  beforeEach(() => {
    mockSendChatMessageWithThinking.mockReset();
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
});
