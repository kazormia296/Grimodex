/**
 * A/B 比較ハーネスの surface 別アダプタ (③)。
 *
 * harness (abHarness.ts) の `AbDispatcher` 実装を 2 種類提供する:
 *  - chat   : 非ストリーミング send_chat_message を 1 回 (model override 付き)。
 *             **ライブ ChatPanel の単一ストリーム描画には一切触れない** — 専用の
 *             比較サーフェスから 2 構成を並列に投げるためだけの経路。
 *  - inline : streamInlineAiText を 1 回 (既に model override 対応・usage 記録込み)。
 *
 * いずれも各生成ごとに recordAiUsage を「呼ぶだけ」(本体改変なし)。
 */

import { sendChatMessageOnceAb } from "@/features/chat/chatApi";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { streamInlineAiText } from "@/features/editor/beat/streamInlineAiText";
import type { AbDispatcher, AbRunResult } from "./abHarness";

/**
 * chat surface の dispatcher。1 構成 = 非ストリーミング 1 ショット。
 * usage は project スコープを明示するため projectId を渡せる。
 */
export function createChatAbDispatcher(
  projectId?: string | null,
): AbDispatcher {
  return async (messages, config): Promise<AbRunResult> => {
    try {
      const res = await sendChatMessageOnceAb(messages, config.model);
      void recordAiUsage({
        surface: "chat",
        model: config.model ?? undefined,
        tokensIn: res.inputTokens,
        tokensOut: res.outputTokens,
        projectId: projectId ?? undefined,
        metadata: { abTest: true },
      });
      return { ok: true, text: res.text };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * inline / beat surface の dispatcher。streamInlineAiText が model override と
 * usage 記録 (surface: inline_ai) を内包しているのでそのまま委譲する。
 */
export const inlineAbDispatcher: AbDispatcher = async (
  messages,
  config,
): Promise<AbRunResult> => {
  const res = await streamInlineAiText(messages, {
    model: config.model ?? undefined,
    usageSurface: "inline_ai",
  });
  if (res.ok) return { ok: true, text: res.text };
  return { ok: false, error: res.error };
};
