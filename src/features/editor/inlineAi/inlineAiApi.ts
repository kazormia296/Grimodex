import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";
import { sendInlineAiStream } from "./inlineAiStreamLoader";
import { getPromptCatalog } from "@/prompts/index";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { serializePromptMessages } from "@/features/attribution/generationLogApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { useTreeStore } from "@/features/tree/treeStore";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";

export function buildSystemPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
  lang = "ja",
): string {
  return getPromptCatalog(lang).inlineAi.buildSystemPrompt(command, ctx);
}

export function buildUserPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
  lang = "ja",
): string {
  return getPromptCatalog(lang).inlineAi.buildUserPrompt(command, ctx);
}

/**
 * インライン AI をストリーミング実行する。
 * - chunk 受信のたびに `onChunk` が呼ばれる（真のストリーミング）
 * - `signal.aborted` になるとバックエンドに abort コマンドを送る
 * - Promise は `stop_reason === "stopped"` でも resolve し、呼び出し側で中止と
 *   通常終了を区別できるよう `stopReason` を返す
 */
export async function generateInlineAi(
  command: InlineAiCommand,
  context: InlineAiContext,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  lang = "ja",
): Promise<{
  text: string;
  model: string;
  stopReason: string;
  promptText: string;
}> {
  const messages = [
    { role: "system", content: buildSystemPrompt(command, context, lang) },
    { role: "user", content: buildUserPrompt(command, context, lang) },
  ];

  // 機能別モデル: inline ロールが設定されていればそれを使い、未設定なら
  // 既定モデル（Rust が settings.model に解決）。未設定時 byte-identical。
  // 横断割り当て時は provider/endpoint/variant も送信へ流す。
  const ov = resolveRoleSendOverride("inline_ai_stream");
  const roleModel = ov.model;

  let accumulated = "";
  const cleanupRef: { fn: (() => void) | null } = { fn: null };
  let abortRequested = false;

  const result = await new Promise<{
    stopReason: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  }>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: {
      stopReason: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cost: number | null;
    }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onAbort = () => {
      abortRequested = true;
      cleanupRef.fn?.();
      signal?.removeEventListener("abort", onAbort);
      // UI/caller settles immediately; the transport cleanup keeps its own
      // correlated audit listeners until the real done/error outcome arrives.
      resolveOnce({
        stopReason: "stopped",
        inputTokens: null,
        outputTokens: null,
        cost: null,
      });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    sendInlineAiStream(
      messages,
      {
        projectId: requireAuditProjectId(useTreeStore.getState().projectId),
        pathId: "inline_ai_stream",
      },
      {
        onTextDelta: (delta) => {
          accumulated += delta;
          onChunk(delta);
        },
        onDone: (info) => {
          signal?.removeEventListener("abort", onAbort);
          resolveOnce({
            stopReason: info.stopReason,
            inputTokens: info.inputTokens,
            outputTokens: info.outputTokens,
            cost: info.cost ?? null,
          });
        },
        onError: (message) => {
          signal?.removeEventListener("abort", onAbort);
          rejectOnce(new Error(message));
        },
      },
      {
        model: roleModel,
        apiVariant: ov.apiVariant,
        provider: ov.provider,
        endpointId: ov.endpointId,
      },
    )
      .then((c) => {
        cleanupRef.fn = c;
        if (abortRequested) c();
      })
      .catch((e: unknown) => {
        rejectOnce(e instanceof Error ? e : new Error(String(e)));
      });
  });

  cleanupRef.fn?.();

  // N4: インライン AI 生成の usage を台帳に記録する (model は設定値を採用)。
  void recordAiUsage({
    surface: "inline_ai",
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
    costUsd: result.cost,
  });

  return {
    text: accumulated,
    // ロール設定時はその値を返す。未設定時は従来どおりの既定ラベル
    // （settings.model を FE が知らないための暫定値。真値化は Phase 2）。
    model: roleModel ?? "claude-sonnet-4-6",
    stopReason: result.stopReason,
    promptText: serializePromptMessages(messages),
  };
}
