import { beforeEach, describe, expect, it, vi } from "vitest";

// 読みの推定（一括・単体の両方）は、作者が hidden（AI に秘匿）と印した Codex の名前・別名を
// AI へ送らない。送信の直前に再判定し、判定に失敗したときは何も送らない（fail-closed）。

const h = vi.hoisted(() => ({
  send: vi.fn(),
  listHidden: vi.fn(),
}));

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: h.send,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/project/api", () => ({
  getProject: vi.fn().mockResolvedValue({ language: "ja" }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p1" }) },
}));
vi.mock("./context/codexHiddenFromAi", () => ({
  listCodexIdsHiddenFromAi: h.listHidden,
}));

import { inferReadings, listYomiHiddenIds } from "./codexYomi";

const entry = (id: string, surface: string) => ({
  id,
  category: "人物",
  surfaces: [surface],
});

function sentPrompt(): string {
  const messages = h.send.mock.calls[0]?.[0] as Array<{ content: string }>;
  return messages[0].content;
}

describe("inferReadings と hidden の Codex", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.listHidden.mockReset();
    h.send.mockResolvedValue({
      text: '{"readings":[{"id":"ok","surface":"刹那","yomi":"せつな"}]}',
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it("hidden の項目を送らず、ほかは送る（判定は送信の直前、project を指定）", async () => {
    h.listHidden.mockResolvedValue(new Set(["secret"]));

    const result = await inferReadings([
      entry("ok", "刹那"),
      entry("secret", "帝都"),
    ]);

    expect(h.listHidden).toHaveBeenCalledWith({
      entryIds: ["ok", "secret"],
      projectId: "p1",
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentPrompt()).toContain("id=ok");
    expect(sentPrompt()).toContain("刹那");
    expect(sentPrompt()).not.toContain("secret");
    expect(sentPrompt()).not.toContain("帝都");
    expect(result.get("ok")).toEqual([{ surface: "刹那", yomi: "せつな" }]);
  });

  it("list の後に hidden へ変わった項目も、送信の直前の再判定で落ちる", async () => {
    // 呼び側（一括推定）の list の時点では late は hidden でない。
    // その後 late が hidden に変わり、inferReadings 側の再判定は hidden と返す。
    h.listHidden
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(["late"]));
    const callerList = await h.listHidden({
      entryIds: ["ok", "late"],
      projectId: "p1",
    });
    expect(callerList.has("late")).toBe(false);

    await inferReadings([entry("ok", "刹那"), entry("late", "剣聖")]);

    expect(h.listHidden).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentPrompt()).toContain("id=ok");
    expect(sentPrompt()).not.toContain("剣聖");
    expect(sentPrompt()).not.toContain("late");
  });

  it("全件 hidden なら送信を呼ばず、空の結果を返す", async () => {
    h.listHidden.mockResolvedValue(new Set(["a", "b"]));

    const result = await inferReadings([
      entry("a", "刹那"),
      entry("b", "帝都"),
    ]);

    expect(result.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("単体（1 項目）でも hidden なら送らない", async () => {
    h.listHidden.mockResolvedValue(new Set(["a"]));

    const result = await inferReadings([entry("a", "刹那")]);

    expect(result.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("hidden の判定に失敗したら何も送らず reject する（fail-closed）", async () => {
    h.listHidden.mockRejectedValue(new Error("db unavailable"));

    await expect(inferReadings([entry("ok", "刹那")])).rejects.toMatchObject({
      code: "CODEX_YOMI_HIDDEN_CHECK_FAILED",
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("hidden でない項目だけなら従来どおり送る", async () => {
    h.listHidden.mockResolvedValue(new Set());

    const result = await inferReadings([entry("ok", "刹那")]);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(result.get("ok")).toEqual([{ surface: "刹那", yomi: "せつな" }]);
  });
});

describe("listYomiHiddenIds（判定を 500 件ずつに分ける）", () => {
  beforeEach(() => {
    h.listHidden.mockReset();
  });

  it("1,001 件は 3 回（500・500・1）に分け、hidden を合わせて返す。projectId は渡したものを使う", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `e${i}`);
    h.listHidden.mockImplementation(
      async ({ entryIds }: { entryIds: string[] }) =>
        new Set(entryIds.filter((id) => id === "e0" || id === "e1000")),
    );

    const hidden = await listYomiHiddenIds(ids, "p-explicit");

    expect(h.listHidden).toHaveBeenCalledTimes(3);
    expect(
      h.listHidden.mock.calls.map(
        ([arg]) => (arg as { entryIds: string[] }).entryIds.length,
      ),
    ).toEqual([500, 500, 1]);
    for (const [arg] of h.listHidden.mock.calls) {
      expect((arg as { projectId: string }).projectId).toBe("p-explicit");
    }
    expect([...hidden].sort()).toEqual(["e0", "e1000"]);
  });

  it("500 件以下は 1 回で、projectId を省くと tree store の project を使う", async () => {
    h.listHidden.mockResolvedValue(new Set(["x"]));

    const hidden = await listYomiHiddenIds(["x", "y"]);

    expect(h.listHidden).toHaveBeenCalledTimes(1);
    expect(h.listHidden).toHaveBeenCalledWith({
      entryIds: ["x", "y"],
      projectId: "p1",
    });
    expect([...hidden]).toEqual(["x"]);
  });

  it("途中の判定が失敗したら、全体が fail-closed で reject する", async () => {
    h.listHidden
      .mockResolvedValueOnce(new Set())
      .mockRejectedValueOnce(new Error("too many SQL variables"));

    await expect(
      listYomiHiddenIds(Array.from({ length: 600 }, (_, i) => `e${i}`)),
    ).rejects.toMatchObject({ code: "CODEX_YOMI_HIDDEN_CHECK_FAILED" });
  });
});
