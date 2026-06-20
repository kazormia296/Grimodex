import { describe, it, expect, vi } from "vitest";

const { mockBlockIfPolicyOff } = vi.hoisted(() => ({
  mockBlockIfPolicyOff: vi.fn(() => false),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlockIfPolicyOff,
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

describe("generateAiBranchCards — AiPolicy gate (chat)", () => {
  it("chat policy が off なら throw し、send_chat_message を呼ばない", async () => {
    mockBlockIfPolicyOff.mockReturnValueOnce(true);
    (invoke as ReturnType<typeof vi.fn>).mockClear();

    const { generateAiBranchCards } = await import("./mapAiApi");
    await expect(generateAiBranchCards("テスト", 3)).rejects.toThrow(
      "chat policy is off",
    );

    expect(mockBlockIfPolicyOff).toHaveBeenCalledWith("chat");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("chat policy が on なら gate を通過して send_chat_message に進む", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: "## a\nb" }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 1);

    expect(mockBlockIfPolicyOff).toHaveBeenCalledWith("chat");
    expect(cards).toHaveLength(1);
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

describe("Verbalized Sampling — parseCards 確率抽出と並べ替え", () => {
  it("emitProbability=true: 確率行を抽出し本文から除去、確率の低い(珍しい)順に並べる", async () => {
    const { parseCards } = await import("./mapAiApi");
    const text = `## タイトルA\n確率: 0.08\n本文A\n\n---\n\n## タイトルB\nprobability: 0.03\n本文B`;
    const cards = parseCards(text, 2, "ja", true);

    // rarest first: B(0.03) を A(0.08) より前に
    expect(cards[0].title).toBe("タイトルB");
    expect(cards[0].probability).toBeCloseTo(0.03);
    expect(cards[1].title).toBe("タイトルA");
    expect(cards[1].probability).toBeCloseTo(0.08);

    // 確率行は本文 doc に混入しない
    const bodyB = JSON.parse(cards[0].body);
    expect(bodyB.content[0].content[0].text).toBe("本文B");
    expect(cards[0].body).not.toContain("0.03");
  });

  it("確率行が無い従来フォーマットは現状どおり(probability undefined・順序保持)", async () => {
    const { parseCards } = await import("./mapAiApi");
    const text = `## A\n本文A\n\n---\n\n## B\n本文B`;
    const cards = parseCards(text, 2, "ja");

    expect(cards[0].title).toBe("A"); // 順序保持(ソートしない)
    expect(cards[0].probability).toBeUndefined();
    expect(JSON.parse(cards[0].body).content[0].content[0].text).toBe("本文A");
  });

  it("VS無効(emitProbability省略)時、確率風の本文行を誤って剥がさない (データロス防止)", async () => {
    const { parseCards } = await import("./mapAiApi");
    // VS オフなので LLM は確率行を出さない。本文が偶然 "確率: …" で始まっても
    // 抽出してはならない (本文消失バグの回帰防止)。
    const text = `## 賭博の話\n確率: 0.5 の賭けに彼は人生を投じた。`;
    const cards = parseCards(text, 1, "ja");

    expect(cards[0].probability).toBeUndefined();
    expect(cards[0].body).toContain("確率: 0.5 の賭けに彼は人生を投じた。");
    expect(JSON.parse(cards[0].body).content[0].content[0].text).toBe(
      "確率: 0.5 の賭けに彼は人生を投じた。",
    );
  });

  it("emitProbability=true でも一部カードに確率が無ければ並べ替えない (混在時は順序保持)", async () => {
    const { parseCards } = await import("./mapAiApi");
    // A=0.08, C=確率行なし, B=0.03。全カードに確率が揃っていないので
    // 並べ替えず入力順 [A, C, B] を保つ (未確定カードを末尾へ飛ばさない)。
    const text = `## A\n確率: 0.08\n本文A\n\n---\n\n## C\n本文C\n\n---\n\n## B\n確率: 0.03\n本文B`;
    const cards = parseCards(text, 3, "ja", true);

    expect(cards.map((c) => c.title)).toEqual(["A", "C", "B"]);
    expect(cards[1].probability).toBeUndefined();
  });
});

describe("Verbalized Sampling — プロンプト組み立て", () => {
  it("buildUserPrompt: emitProbability=true で確率行フォーマットを含み、false では含まない", async () => {
    const { buildUserPrompt } = await import("./mapAiApi");
    expect(buildUserPrompt("t", 3, [], "ja", true)).toMatch(/確率\s*[:：]/);
    expect(buildUserPrompt("t", 3, [], "ja", false)).not.toMatch(
      /確率\s*[:：]/,
    );
    // 既定 (引数省略) は従来どおり確率行なし
    expect(buildUserPrompt("t", 3, [], "ja")).not.toMatch(/確率\s*[:：]/);
  });

  it("buildSystemPrompt: vs 指定で VS 指示を末尾に足し、しきい値を反映する", async () => {
    const { buildSystemPrompt } = await import("./mapAiApi");
    const withVs = buildSystemPrompt({ title: "P" }, [], { threshold: 0.05 });
    expect(withVs).toContain("Verbalized Sampling");
    expect(withVs).toContain("0.05");

    const noVs = buildSystemPrompt({ title: "P" }, []);
    expect(noVs).not.toContain("Verbalized Sampling");
  });
});

describe("Verbalized Sampling — generateAiBranchCards フルチェーン配線(実ペイロード)", () => {
  function lastMessages(): Array<{ role: string; content: string }> {
    const calls = (invoke as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = [...calls]
      .reverse()
      .find((c) => c[0] === "send_chat_message");
    return (
      sendCall![1] as { messages: Array<{ role: string; content: string }> }
    ).messages;
  }

  it("vs 指定で system に VS 指示+しきい値、user に確率フォーマットが実際に載る", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: "## a\n確率: 0.04\n本文" }],
      stopReason: "end_turn",
    });
    const { generateAiBranchCards } = await import("./mapAiApi");
    await generateAiBranchCards("テーマ", 3, [], { title: "P" }, [], {
      threshold: 0.05,
    });
    const msgs = lastMessages();
    const sys = msgs.find((m) => m.role === "system")!.content;
    const usr = msgs.find((m) => m.role === "user")!.content;
    expect(sys).toContain("Verbalized Sampling");
    expect(sys).toContain("0.05");
    expect(usr).toMatch(/確率\s*[:：]/);
  });

  it("vs 省略時は VS 指示も確率フォーマットも載らない(従来不変)", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ type: "text", content: "## a\n本文" }],
      stopReason: "end_turn",
    });
    const { generateAiBranchCards } = await import("./mapAiApi");
    await generateAiBranchCards("テーマ", 3, [], { title: "P" });
    const msgs = lastMessages();
    expect(msgs.find((m) => m.role === "system")!.content).not.toContain(
      "Verbalized Sampling",
    );
    expect(msgs.find((m) => m.role === "user")!.content).not.toMatch(
      /確率\s*[:：]/,
    );
  });
});
