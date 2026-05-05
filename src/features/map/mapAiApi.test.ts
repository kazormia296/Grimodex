import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
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
