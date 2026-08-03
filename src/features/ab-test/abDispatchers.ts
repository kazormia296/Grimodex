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
import { resolveSlotApiVariant } from "./abConfig";

function resolveAbProjectAuthority(
  factoryProjectId: string | null | undefined,
  dispatchProjectId: string | null,
): string | null {
  const normalizedFactoryProjectId = factoryProjectId?.trim() || null;
  if (
    factoryProjectId !== undefined &&
    normalizedFactoryProjectId !== dispatchProjectId
  ) {
    throw new Error(
      `AI_AUDIT_PROJECT_CHANGED: expected ${normalizedFactoryProjectId ?? "workspace"}, active ${dispatchProjectId ?? "workspace"}`,
    );
  }
  return dispatchProjectId;
}

/**
 * chat surface の dispatcher。1 構成 = 非ストリーミング 1 ショット。
 * provider override (枠ごとの別プロバイダ) を per-call で渡す。provider を上書きする
 * 枠は API 経路 (variant) も枠の provider に合わせて解決する (Sakana=responses)。
 * usage は project スコープを明示するため projectId を渡せる。
 */
export function createChatAbDispatcher(
  projectId?: string | null,
): AbDispatcher {
  return async (messages, config, context): Promise<AbRunResult> => {
    try {
      const slotContext = context;
      const auditProjectId = resolveAbProjectAuthority(
        projectId,
        slotContext.projectId,
      );
      const provider = config.provider?.trim() || undefined;
      const apiVariant = resolveSlotApiVariant(config);
      // OpenAI 互換の枠だけ endpoint override を糸通しする (他 provider では backend が無視)。
      const endpointId =
        provider === "openai-compatible"
          ? config.endpointId?.trim() || undefined
          : undefined;
      const res = await sendChatMessageOnceAb(
        messages,
        {
          projectId: auditProjectId,
          expectedWorkspacePath: slotContext.expectedWorkspacePath,
          pathId: "ab_chat",
          operationId: slotContext.operationId,
          metadata: {
            slotIndex: slotContext.slotIndex,
            configFingerprint: slotContext.configFingerprint,
          },
        },
        config.model,
        provider,
        apiVariant,
        endpointId,
      );
      void recordAiUsage({
        surface: "chat",
        model: config.model ?? undefined,
        tokensIn: res.inputTokens,
        tokensOut: res.outputTokens,
        projectId: auditProjectId ?? undefined,
        metadata: { abTest: true, provider: provider ?? null },
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
 * usage は project スコープを明示するため projectId を渡せる。
 */
export function createInlineAbDispatcher(
  projectId?: string | null,
): AbDispatcher {
  return async (messages, config, context): Promise<AbRunResult> => {
    const slotContext = context;
    const auditProjectId = resolveAbProjectAuthority(
      projectId,
      slotContext.projectId,
    );
    const res = await streamInlineAiText(messages, {
      model: config.model ?? undefined,
      usageSurface: "inline_ai",
      projectId: auditProjectId,
      auditExpectedWorkspacePath: slotContext.expectedWorkspacePath,
      auditPathId: "ab_inline",
      auditOperationId: slotContext.operationId,
      auditMetadata: {
        slotIndex: slotContext.slotIndex,
        configFingerprint: slotContext.configFingerprint,
      },
    });
    if (res.ok) return { ok: true, text: res.text };
    return { ok: false, error: res.error };
  };
}
