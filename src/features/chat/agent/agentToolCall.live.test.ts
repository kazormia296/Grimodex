/**
 * Agent ツールコール **ライブ** E2E（実 LLM）。
 *
 * 汎用ハーネス {@link file://./aiLiveHarness.ts} を使って、本 PR の挙動を実モデル
 * （OpenRouter, native tool calling）で検証する。このファイル自体がハーネスの
 * 使い方サンプルも兼ねる:
 *   S1 基本ツールループ        — モデルが tool_call を発行しループが最終回答へ到達
 *   S2 run_research サブエージェント — 親が委譲→子が自分で read→要約返却（depth=1）
 *   S3 model-aware 上限         — maxToolCalls で打ち切り stoppedReason=limit_calls
 *
 * 既定 SKIP。実行（実トークン課金あり）:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/chat/agent/agentToolCall.live.test.ts
 *   モデル上書き: OPENROUTER_MODEL（既定 openai/gpt-4o-mini）。
 */
import { describe, it, expect, vi } from "vitest";

// runAgentLoop は本物を使うが tokenizer の WASM ロードは避ける。
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => (s ? s.length : 0),
}));

import {
  getDeterministicAgentTools,
  getResearchSubagentTools,
  RESEARCH_SUBAGENT_TOOL,
} from "./toolDefinitions";
import type { AgentToolDefinition } from "./agentTypes";
import {
  liveApiKey,
  liveModel,
  runLiveAgent,
  createMockReadOnlyExecutor,
  createOpenRouterSendToLLM,
  createResearchInterceptor,
  type ToolCallEvent,
} from "./aiLiveHarness";

const KEY = liveApiKey();
const LIVE_TIMEOUT = 120_000;

function names(events: ToolCallEvent[], depth?: number): string[] {
  return events
    .filter((e) => depth === undefined || e.depth === depth)
    .map((e) => e.name);
}

describe.skipIf(!KEY)(`agent tool-call live E2E (${liveModel()})`, () => {
  it(
    "S1: real model emits tool_calls and the loop reaches a final answer",
    async () => {
      const res = await runLiveAgent({
        system:
          "あなたは小説執筆を助けるアシスタントです。質問に答えるには、必ず利用可能なツールで作品データ（Codex/シーン）を調べてから答えること。",
        user: "蓮はどんな人物で、どのシーンに登場しますか？",
        tools: getResearchSubagentTools(),
        executeTool: createMockReadOnlyExecutor(),
      });

      console.log("S1 tool calls:", names(res.toolCalls));
      console.log("S1 final:", res.finalText.slice(0, 200));
      console.log(`S1 tokens in/out: ${res.tokensIn}/${res.tokensOut}`);

      expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(res.finalText.trim().length).toBeGreaterThan(0);
      expect(res.stoppedReason).toBe("completed");
    },
    LIVE_TIMEOUT,
  );

  it(
    "S2: run_research spawns a nested read-only sub-agent (depth=1) that does its own reads",
    async () => {
      const parentTools: AgentToolDefinition[] = [
        ...getResearchSubagentTools(),
        getDeterministicAgentTools().find(
          (t) => t.name === RESEARCH_SUBAGENT_TOOL,
        )!,
      ];
      // 親(depth0)＋子(depth1)の tool_call を 1 本の trace に集約する。
      const sink: ToolCallEvent[] = [];
      const executor = createResearchInterceptor({
        baseExecutor: createMockReadOnlyExecutor(),
        childSendToLLM: createOpenRouterSendToLLM(),
        sink,
      });

      const res = await runLiveAgent({
        system:
          "あなたは小説執筆アシスタントです。複数の検索が要る自己完結した調査は、必ず run_research ツールに委譲してください（自分で何度も検索しないこと）。",
        user: "芽衣について、登場する全シーンと、彼女に関連する未回収の伏線を調べてまとめてください。",
        tools: parentTools,
        executeTool: executor,
        sink,
        // 委譲経路を決定的に踏むため、最初の 1 手を run_research に強制する。
        send: {
          firstToolChoice: {
            type: "function",
            function: { name: RESEARCH_SUBAGENT_TOOL },
          },
        },
      });

      console.log("S2 parent calls:", names(res.toolCalls, 0));
      console.log("S2 child calls:", names(res.toolCalls, 1));
      console.log("S2 final:", res.finalText.slice(0, 200));

      // 親は run_research を呼んだ。
      expect(names(res.toolCalls, 0)).toContain(RESEARCH_SUBAGENT_TOOL);
      // 子は実際に read ツールを自分で呼んだ（ネストが機能している）。
      expect(
        res.toolCalls.filter((e) => e.depth === 1).length,
      ).toBeGreaterThanOrEqual(1);
      // depth=1: 子は run_research を一度も呼べない（宣言されていない）。
      expect(names(res.toolCalls, 1)).not.toContain(RESEARCH_SUBAGENT_TOOL);
      // 親は最終回答に到達。
      expect(res.finalText.trim().length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT,
  );

  it(
    "S3: a low maxToolCalls cuts the loop off with stoppedReason=limit_calls",
    async () => {
      const res = await runLiveAgent({
        system:
          "あなたは小説執筆アシスタントです。答える前に、登場人物を一人ずつツールで丁寧に調べてください。",
        user: "この作品の全登場人物それぞれの関係性を、一人ずつ個別に調べてから説明してください。",
        tools: getResearchSubagentTools(),
        executeTool: createMockReadOnlyExecutor(),
        maxToolCalls: 2,
        // 各ターン必ずツールを呼ばせ、2 回で上限に達する経路を決定的に踏む。
        send: { firstToolChoice: "required", restToolChoice: "required" },
      });

      console.log("S3 tool calls:", names(res.toolCalls));
      console.log("S3 stoppedReason:", res.stoppedReason);

      // maxToolCalls はターン**バッチ後**判定のため、1 ターンで並列 tool_call が
      // 来ると 1 バッチ分オーバーシュートしうる（ソフト境界）。重要なのは「上限で
      // 確実に打ち切られる」こと。
      expect(res.toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(res.stoppedReason).toBe("limit_calls");
    },
    LIVE_TIMEOUT,
  );
});
