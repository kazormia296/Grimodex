import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBlockIfPolicyOff, mockInvoke } = vi.hoisted(() => ({
  mockBlockIfPolicyOff: vi.fn(() => false),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: mockInvoke,
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
import { useWorkspaceStore } from "@/features/workspace/store";

let nextChatResponse: unknown;

function mockChatResponse(response: unknown): void {
  nextChatResponse = response;
}

beforeEach(() => {
  nextChatResponse = undefined;
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === "send_chat_message") return nextChatResponse;
    if (command === "ai_audit_append_batch") {
      return { insertedCount: 1, tailSequence: 1, tailHash: "hash" };
    }
    return undefined;
  });
  useWorkspaceStore.setState({
    activeWorkspacePath: "/workspace",
    workspaceSwitchInProgress: false,
  });
});

describe("generateAiBranchCards — LLM レスポンスのパース", () => {
  it("--- 区切りで N 枚のカードに分割する", async () => {
    const llmText = `## タイトル1\n本文1\n\n---\n\n## タイトル2\n本文2\n\n---\n\n## タイトル3\n本文3`;

    mockChatResponse({
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

    mockChatResponse({
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

    mockChatResponse({
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

    mockChatResponse({
      blocks: [{ type: "text", content: llmText }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 2);

    expect(cards[0].title).toBe("タイトルだけ");
    expect(cards[1].title).toBe("別タイトル");
  });
});

describe("generateAiBranchCards — 空応答ガード (silent-pad 廃止)", () => {
  it("text ブロックが 0 件なら AiBranchEmptyResponseError を投げる(pad で隠さない)", async () => {
    mockChatResponse({
      blocks: [],
      stopReason: "max_tokens",
    });

    const { generateAiBranchCards, AiBranchEmptyResponseError } =
      await import("./mapAiApi");
    await expect(generateAiBranchCards("テスト", 3)).rejects.toBeInstanceOf(
      AiBranchEmptyResponseError,
    );
  });

  it("thinking ブロックだけ(回答 text 無し)でも空応答として投げる", async () => {
    // 推論モデルは content 空 + reasoning(thinking)のみを返しうる。reasoning は
    // ユーザー向けの回答ではないため、text 0 件は失敗として扱う。
    mockChatResponse({
      blocks: [{ type: "thinking", content: "考え中…" }],
      stopReason: "max_tokens",
    });

    const { generateAiBranchCards, AiBranchEmptyResponseError } =
      await import("./mapAiApi");
    await expect(generateAiBranchCards("テスト", 3)).rejects.toBeInstanceOf(
      AiBranchEmptyResponseError,
    );
  });

  it("実カードが 1 枚でもあれば従来どおり partial pad する(throw しない)", async () => {
    mockChatResponse({
      blocks: [{ type: "text", content: "## アイデア1\n本文1" }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 3);
    expect(cards).toHaveLength(3);
    expect(cards[0].title).toBe("アイデア1");
    expect(cards[1].title).toBe("アイデア 2");
  });

  it("不完全セグメント(タイトルのみ・本文無し)が混じっても throw せず pad で補完する", async () => {
    // 境界: 1 枚でも実セグメントがあれば throw 経路には入らず、従来どおり pad する。
    mockChatResponse({
      blocks: [{ type: "text", content: "## T1\n本文1\n\n---\n\n## T2" }],
      stopReason: "end_turn",
    });

    const { generateAiBranchCards } = await import("./mapAiApi");
    const cards = await generateAiBranchCards("テスト", 3);
    expect(cards).toHaveLength(3);
    expect(cards[0].title).toBe("T1");
    expect(cards[1].title).toBe("T2"); // 本文無しでも実カード
    expect(cards[2].title).toBe("アイデア 3"); // pad
  });
});

describe("parseCards — 空応答 pad が 0.400 アーティファクトを生む(根本原因の固定)", () => {
  it('空テキストの pad("アイデア N")の meanPairwiseDistinctness は ≈0.400', async () => {
    const { parseCards } = await import("./mapAiApi");
    const { meanPairwiseDistinctness } = await import("@/lib/textDiversity");

    const cards = parseCards("", 5, "ja", true);
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => /^アイデア \d+$/.test(c.title))).toBe(true);

    // VS ライブ検証が観測した lexOff=lexOn=0.400/全 tie は、推論モデルの空応答を
    // parseCards が "アイデア 1..5" で pad した結果の文字 bigram 相違度そのもの
    // (モデル出力でも VS の効果でもない)。両 arm が同一 pad 集合になるため tie。
    const texts = cards.map((c) => {
      const doc = JSON.parse(c.body) as {
        content?: Array<{ content?: Array<{ text?: string }> }>;
      };
      const body = (doc.content ?? [])
        .flatMap((n) => (n.content ?? []).map((t) => t.text ?? ""))
        .join(" ");
      return `${c.title} ${body}`;
    });
    expect(meanPairwiseDistinctness(texts)).toBeCloseTo(0.4, 6);
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
    mockChatResponse({
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
    mockChatResponse({
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
    mockChatResponse({
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
    mockChatResponse({
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
    mockChatResponse({
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

describe("generateAiBranchCards — per-role 横断の invoke ペイロード配線（finding 10）", () => {
  it("override 未設定でも send_chat_message に provider/endpointId/apiVariant が正しいキーで載る（欠落/誤キー検出・null=byte-identical）", async () => {
    mockChatResponse({
      blocks: [{ type: "text", content: "## a\nb" }],
      stopReason: "end_turn",
    });
    const { generateAiBranchCards } = await import("./mapAiApi");
    await generateAiBranchCards("テスト", 1);

    const calls = (invoke as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = [...calls]
      .reverse()
      .find((c) => c[0] === "send_chat_message");
    const payload = sendCall![1] as Record<string, unknown>;
    // per-role 横断で追加された 4 フィールドが「正しいキー名」で存在すること。
    // resolveRoleSendOverride の値生成は modelRouting.test で検証済み。ここは
    // フィールドが invoke 本体に正しいキーで糸通しされている配線を固定する。
    expect(payload).toHaveProperty("provider", null);
    expect(payload).toHaveProperty("endpointId", null);
    expect(payload).toHaveProperty("apiVariant", null);
    expect(payload).toHaveProperty("model", null);
  });
});
