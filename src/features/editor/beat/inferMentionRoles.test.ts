import { describe, it, expect, vi, beforeEach } from "vitest";
import { inferMentionRoles } from "./inferMentionRoles";

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p1" }) },
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspacePath: "/workspace/test.gdx",
      workspaceSwitchInProgress: false,
    }),
  },
}));

import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
const mockSend = vi.mocked(sendChatMessageWithThinking);

function makeResult(text: string) {
  return { text, thinkingBlocks: [], inputTokens: 0, outputTokens: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const BASE_MENTIONS = [
  { codexId: "c1", name: "花子", currentRole: "mentioned" as const },
  { codexId: "c2", name: "太郎", currentRole: "mentioned" as const },
];

describe("inferMentionRoles", () => {
  it("mentions が空なら API を呼ばず空配列を返す", async () => {
    const result = await inferMentionRoles({
      beatInstructions: "何かが起きる",
      generatedProse: "本文",
      mentions: [],
    });
    expect(result).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("正常な JSON レスポンスをパースして RoleSuggestion 配列を返す", async () => {
    mockSend.mockResolvedValue(
      makeResult(
        '{"results":[{"codexId":"c1","role":"actor","confidence":0.9},{"codexId":"c2","role":"target","confidence":0.8}]}',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "花子が太郎を助ける",
      generatedProse: "花子は駆け寄り、太郎の手を握った。",
      mentions: BASE_MENTIONS,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      codexId: "c1",
      role: "actor",
      confidence: 0.9,
    });
    expect(result[1]).toMatchObject({
      codexId: "c2",
      role: "target",
      confidence: 0.8,
    });
  });

  it("JSON が不正なとき空配列を返す", async () => {
    mockSend.mockResolvedValue(makeResult("invalid json response"));
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toEqual([]);
  });

  it("results フィールドが配列でないとき空配列を返す", async () => {
    mockSend.mockResolvedValue(makeResult('{"results":"not-array"}'));
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toEqual([]);
  });

  it("role が不正な値の item は無視する", async () => {
    mockSend.mockResolvedValue(
      makeResult(
        '{"results":[{"codexId":"c1","role":"invalid","confidence":0.9},{"codexId":"c2","role":"actor","confidence":0.7}]}',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toHaveLength(1);
    expect(result[0].codexId).toBe("c2");
  });

  it("API 呼び出しが例外を投げたとき空配列を返す", async () => {
    mockSend.mockRejectedValue(new Error("network error"));
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toEqual([]);
  });

  it("confidence が 0〜1 の範囲にクランプされる", async () => {
    mockSend.mockResolvedValue(
      makeResult(
        '{"results":[{"codexId":"c1","role":"actor","confidence":1.5},{"codexId":"c2","role":"target","confidence":-0.3}]}',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result[0].confidence).toBe(1);
    expect(result[1].confidence).toBe(0);
  });

  it("レスポンスに前後にテキストがあっても JSON を抽出してパースする", async () => {
    mockSend.mockResolvedValue(
      makeResult(
        'Sure! Here is the analysis:\n{"results":[{"codexId":"c1","role":"actor","confidence":0.85}]}\nDone.',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("actor");
  });

  it("説明文中に別の {} が混じっても最初の balanced object を抽出する", async () => {
    // 旧実装は最初の `{` から最後の `}` まで切るので、説明文中に `{...}` が
    // 含まれると不正な連結 JSON になり parse が落ちていた。
    mockSend.mockResolvedValue(
      makeResult(
        'Note: ignore objects like {"foo":"bar"}.\nResult: {"results":[{"codexId":"c1","role":"actor","confidence":0.9}]}',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toHaveLength(0); // 最初の {"foo":"bar"} には results がないので空
  });

  it("results に入れ子オブジェクト（item 内に {}）が含まれても全体を切り出せる", async () => {
    mockSend.mockResolvedValue(
      makeResult(
        '{"results":[{"codexId":"c1","role":"actor","confidence":0.9,"meta":{"src":"x"}}]}',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toHaveLength(1);
    expect(result[0].codexId).toBe("c1");
  });

  it("文字列リテラル中の `{` `}` を括弧バランスとしてカウントしない", async () => {
    mockSend.mockResolvedValue(
      makeResult(
        '{"results":[{"codexId":"c1","role":"actor","confidence":0.9,"note":"contains } and { chars"}]}',
      ),
    );
    const result = await inferMentionRoles({
      beatInstructions: "test",
      generatedProse: "test",
      mentions: BASE_MENTIONS,
    });
    expect(result).toHaveLength(1);
  });
});
