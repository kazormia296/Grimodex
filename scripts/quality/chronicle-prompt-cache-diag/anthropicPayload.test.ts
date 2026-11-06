import { describe, expect, it, vi } from "vitest";
import {
  buildChroniclePromptRequest,
  type ChroniclePromptRoute,
} from "@/application/narrative-extraction/aiTasks/chroniclePromptCache";
import { buildSynthesisPromptArtifact } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  buildAnthropicBody,
  buildAnthropicHeaders,
  defaultMaxTokens,
  parseAnthropicResponse,
  sendAnthropicMessages,
  thinkingAlwaysOn,
} from "./anthropicPayload";

const MODEL = "claude-sonnet-5-5";
const ANTHROPIC: ChroniclePromptRoute = {
  provider: "anthropic",
  model: MODEL,
  apiVariant: null,
};
const OPENAI: ChroniclePromptRoute = {
  provider: "openai",
  model: MODEL,
  apiVariant: null,
};

function observation(
  localId: string,
  quote: string,
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef: "S0001", quote }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "門が開いた",
      actuality: "actual",
      participants: [],
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
}

describe("製品の request から Messages API の body を作る", () => {
  const artifact = buildSynthesisPromptArtifact({
    clusterRef: "cluster-1",
    observations: [observation("obs-1", "門が開いた。")],
  });
  const full = artifact.messages[0].content;

  it("分割あり: system は cache_control 付きの block 配列で、連結が元の prompt と同じ", () => {
    const request = buildChroniclePromptRequest(artifact, ANTHROPIC);
    expect(request.systemCacheSegments).toHaveLength(1);
    const body = buildAnthropicBody({
      model: MODEL,
      messages: request.messages,
      systemCacheSegments: request.systemCacheSegments,
    });
    expect(Array.isArray(body.system)).toBe(true);
    const blocks = body.system as {
      type: string;
      text: string;
      cache_control: { type: string };
    }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe("user");
    // モデルが読む順（system → user）の連結は元の 1 つの user message と一字一句同じ。
    expect(blocks[0]!.text + body.messages[0]!.content).toBe(full);
    // Scene 本文・ref は cache される block に入らない。
    expect(blocks[0]!.text).not.toContain("cluster-1");
    expect(blocks[0]!.text).not.toContain("門が開いた。");
  });

  it("分割なし: system を付けず、user に全文を 1 つ", () => {
    const request = buildChroniclePromptRequest(artifact, OPENAI);
    expect(request.systemCacheSegments).toBeUndefined();
    const body = buildAnthropicBody({
      model: MODEL,
      messages: request.messages,
      systemCacheSegments: request.systemCacheSegments,
    });
    expect(body).not.toHaveProperty("system");
    expect(body.messages).toEqual([{ role: "user", content: full }]);
  });

  it("製品と同じ既定: thinking・temperature を付けず、max_tokens は 5 世代で 32,000", () => {
    const body = buildAnthropicBody({
      model: MODEL,
      messages: [{ role: "user", content: "x" }],
    });
    expect(body).toEqual({
      model: MODEL,
      max_tokens: 32_000,
      messages: [{ role: "user", content: "x" }],
    });
    expect(defaultMaxTokens("claude-sonnet-4-5")).toBe(4096);
    expect(thinkingAlwaysOn("claude-opus-5-5")).toBe(true);
    expect(thinkingAlwaysOn("claude-sonnet-4-5")).toBe(false);
    expect(thinkingAlwaysOn("gpt-5")).toBe(false);
  });

  it("Rust の build_system_payload と同じ fallback（空 segment・system message のみ）", () => {
    const system = buildAnthropicBody({
      model: MODEL,
      messages: [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "user", content: "u" },
      ],
    });
    expect(system.system).toBe("a\nb");
    const emptySegments = buildAnthropicBody({
      model: MODEL,
      messages: [{ role: "user", content: "u" }],
      systemCacheSegments: ["", ""],
    });
    expect(emptySegments.system).toBe("\n");
    const mixed = buildAnthropicBody({
      model: MODEL,
      messages: [{ role: "user", content: "u" }],
      systemCacheSegments: ["", "s"],
    });
    expect(mixed.system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("header", () => {
  it("segment があるときだけ prompt-caching の beta header を付ける", () => {
    const withSegment = buildAnthropicHeaders({
      apiKey: "k",
      systemCacheSegments: ["s"],
    });
    expect(withSegment["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(withSegment["anthropic-version"]).toBe("2023-06-01");
    expect(buildAnthropicHeaders({ apiKey: "k" })).not.toHaveProperty(
      "anthropic-beta",
    );
    expect(
      buildAnthropicHeaders({ apiKey: "k", systemCacheSegments: [""] }),
    ).not.toHaveProperty("anthropic-beta");
  });
});

describe("response", () => {
  it("text block だけを \\n で連結し、usage の 4 種を取る", () => {
    const parsed = parseAnthropicResponse({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    });
    expect(parsed.text).toBe("a\nb");
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    });
  });
});

describe("sendAnthropicMessages（API は mock）", () => {
  const body = buildAnthropicBody({
    model: MODEL,
    messages: [{ role: "user", content: "u" }],
  });
  const ok = () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      { status: 200 },
    );

  it("429 は backoff して再送し、成功を返す。key は header にだけ載る", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    const result = await sendAnthropicMessages({
      apiKey: "sk-ant-secret",
      body,
      fetchImpl,
      sleep,
    });
    expect(result.text).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
      "sk-ant-secret",
    );
    expect(String(init.body)).not.toContain("sk-ant-secret");
  });

  it("400 は再送せず、例外に key も本文も入れない", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "m" },
        }),
        { status: 400 },
      ),
    );
    await expect(
      sendAnthropicMessages({
        apiKey: "sk-ant-secret",
        body,
        fetchImpl,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("http 400 invalid_request_error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("再送を使い切ったら失敗する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 529 }));
    await expect(
      sendAnthropicMessages({
        apiKey: "k",
        body,
        fetchImpl,
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("http 529");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
