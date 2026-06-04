import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

// N4: recordAiUsage は db.insert 経由で invoke("db_execute") を発火する。
// このテストの invoke は bare vi.fn() なので drizzle proxy がハングする。
// 台帳記録はここでの検証対象外なので no-op にして切り離す。
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));

import { invoke } from "@/lib/tauri";

describe("generateAiBranchCards — LLM レスポンスのパース", () => {
  it("--- 区切りで N 枚のカードに分割する", async () => {
    const llmText = `## タイトル1\n本文1\n\n---\n\n## タイトル2\n本文2\n\n---\n\n## タイトル3\n本文3`;

    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: llmText }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 3);

    expect(cards).toHaveLength(3);
    expect(cards[0].title).toBe("タイトル1");
    expect(cards[1].title).toBe("タイトル2");
    expect(cards[2].title).toBe("タイトル3");
  });

  it("body を ProseMirror doc JSON に変換する", async () => {
    const llmText = `## アイデア\n詳細テキスト`;

    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: llmText }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 1);

    const body = JSON.parse(cards[0].body);
    expect(body.type).toBe("doc");
    expect(body.content[0].type).toBe("paragraph");
    expect(body.content[0].content[0].text).toBe("詳細テキスト");
  });

  it("LLM が count より少なく返したとき空カードで補完する", async () => {
    const llmText = `## アイデア1\n本文1`;

    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: llmText }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 3);

    expect(cards).toHaveLength(3);
    expect(cards[0].title).toBe("アイデア1");
    expect(cards[1].title).toBe("アイデア 2");
    expect(cards[2].title).toBe("アイデア 3");
  });

  it("# ヘッダーなしのセグメントは先頭行をタイトルにする", async () => {
    const llmText = `タイトルだけ\n\n---\n\n別タイトル\n説明文`;

    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: llmText }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 2);

    expect(cards[0].title).toBe("タイトルだけ");
    expect(cards[1].title).toBe("別タイトル");
  });
});

describe("generateAiBranchCards — customInstruction (aiPrompt.custom.aiBranch)", () => {
  function lastSystemPrompt(): string {
    const calls = (invoke as ReturnType<typeof vi.fn>).mock.calls;
    // N4: recordAiUsage が db_execute invoke を別途発火するため、
    // send_chat_message 呼び出しを特定して取り出す。
    const sendCall = [...calls]
      .reverse()
      .find((c) => c[0] === "send_chat_message");
    const payload = sendCall![1] as {
      messages: Array<{ role: string; content: string }>;
    };
    return payload.messages.find((m) => m.role === "system")!.content;
  }

  it("custom 非空なら system に「# ユーザー追加指示」として入る", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: "## a\nb" }],
      stopReason: "end_turn",
    });
    const { generateAiBranchCards } = await import("./mapAiApi");
    await generateAiBranchCards("テスト", 1, [], {
      title: "P",
      customInstruction: "意外性のある展開を優先して",
    });
    const sys = lastSystemPrompt();
    expect(sys).toContain("# ユーザー追加指示");
    expect(sys).toContain("意外性のある展開を優先して");
  });

  it("custom 空なら「# ユーザー追加指示」は出ず、aiInstructions の「# 追加指示」とは別建て", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: "## a\nb" }],
      stopReason: "end_turn",
    });
    const { generateAiBranchCards } = await import("./mapAiApi");
    await generateAiBranchCards("テスト", 1, [], {
      title: "P",
      aiInstructions: "横断的なプロジェクト指示",
      customInstruction: "",
    });
    const sys = lastSystemPrompt();
    expect(sys).not.toContain("# ユーザー追加指示");
    // aiInstructions (横断的指示) は従来どおり「# 追加指示」として残る
    expect(sys).toContain("# 追加指示");
    expect(sys).toContain("横断的なプロジェクト指示");
  });
});
