import { describe, it, expect, vi, afterEach } from "vitest";
import { runLiveSingleShot, DEFAULT_LIVE_MAX_TOKENS } from "./aiLiveHarness";

/**
 * fetch を stub して OpenRouter 応答を差し替える(ネットワーク不要の決定的テスト)。
 * createOpenRouterSendToLLM は `res.ok` と `res.json()` のみ参照する。
 */
function mockFetchOnce(json: unknown) {
  const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runLiveSingleShot — 空応答ガード", () => {
  it("content 空(text 0 件)なら throw する(黙って '' を返さない)", async () => {
    mockFetchOnce({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await expect(
      runLiveSingleShot("hi", { send: { apiKey: "sk-test" } }),
    ).rejects.toThrow(/empty text/);
  });

  it("finish_reason=length(stopReason max_tokens)なら推論モデルのヒントを添える", async () => {
    mockFetchOnce({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    });

    await expect(
      runLiveSingleShot("hi", { send: { apiKey: "sk-test" } }),
    ).rejects.toThrow(/reasoning model/);
  });

  it("finish_reason=stop(max_tokens 以外)の空応答はヒント無しで throw する", async () => {
    mockFetchOnce({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
    });

    let msg = "";
    try {
      await runLiveSingleShot("hi", { send: { apiKey: "sk-test" } });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/empty text/);
    expect(msg).not.toMatch(/reasoning model/);
  });

  it("通常応答(content あり)はそのまま返す", async () => {
    mockFetchOnce({
      choices: [{ message: { content: "やあ" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });

    const res = await runLiveSingleShot("hi", { send: { apiKey: "sk-test" } });
    expect(res.text).toBe("やあ");
    expect(res.tokensOut).toBe(3);
    expect(res.stopReason).toBe("end_turn");
  });
});

describe("createOpenRouterSendToLLM — 既定 max_tokens", () => {
  it(`既定で max_tokens=${DEFAULT_LIVE_MAX_TOKENS} を送る(推論モデルの予算枯渇回避)`, async () => {
    const fetchMock = mockFetchOnce({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    await runLiveSingleShot("hi", { send: { apiKey: "sk-test" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as unknown as { body: string };
    const body = JSON.parse(init.body) as { max_tokens?: number };
    expect(body.max_tokens).toBe(DEFAULT_LIVE_MAX_TOKENS);
  });

  it("send.maxTokens 指定時はそれを優先する", async () => {
    const fetchMock = mockFetchOnce({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    await runLiveSingleShot("hi", {
      send: { apiKey: "sk-test", maxTokens: 256 },
    });

    const init = fetchMock.mock.calls[0][1] as unknown as { body: string };
    const body = JSON.parse(init.body) as { max_tokens?: number };
    expect(body.max_tokens).toBe(256);
  });

  it("reasoning effort と raw exchange を資格情報なしで観測できる", async () => {
    const fetchMock = mockFetchOnce({
      id: "gen-1",
      model: "openai/gpt-5.6-luna-20260709",
      provider: "OpenAI",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 5, cost: 0.001 },
    });
    const exchanges: unknown[] = [];

    await runLiveSingleShot("hi", {
      send: {
        apiKey: "sk-test",
        reasoning: { effort: "medium" },
        onRawExchange: (exchange) => exchanges.push(exchange),
      },
    });

    const init = fetchMock.mock.calls[0][1] as unknown as {
      body: string;
      headers: Record<string, string>;
    };
    expect(JSON.parse(init.body)).toMatchObject({
      reasoning: { effort: "medium" },
    });
    expect(exchanges).toEqual([
      expect.objectContaining({
        call: 1,
        elapsedMs: expect.any(Number),
        request: expect.not.objectContaining({
          apiKey: expect.anything(),
          authorization: expect.anything(),
        }),
        response: expect.objectContaining({
          id: "gen-1",
          model: "openai/gpt-5.6-luna-20260709",
          provider: "OpenAI",
        }),
      }),
    ]);
  });
});
