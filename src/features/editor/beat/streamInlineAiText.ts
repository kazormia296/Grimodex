import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import {
  recordAiUsage,
  type AiUsageSurface,
} from "@/features/ai-usage/recordAiUsage";
import { useTreeStore } from "@/features/tree/treeStore";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";

export type InlineAiTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface StreamInlineAiTextOptions {
  model?: string;
  /** 別プロバイダ送信時の解決済み API 経路（variant）。 */
  apiVariant?: string | null;
  /** 機能別モデルのプロバイダ横断 override。 */
  provider?: string | null;
  /** OpenAI 互換で別エンドポイントを選んでいるときの endpoint id。 */
  endpointId?: string | null;
  usageSurface?: AiUsageSurface;
  /** usage 台帳の project スコープ明示。省略時は active project にフォールバック。 */
  projectId?: string | null;
  /** Immutable ledger authority for a parent multi-dispatch operation. */
  auditExpectedWorkspacePath?: string;
  /** Registry path for the exact Beat/A-B/synopsis surface. */
  auditPathId:
    | "ab_inline"
    | "beat_alternative"
    | "beats_from_synopsis"
    | "synopsis_from_beats";
  auditOperationId?: string;
  auditMetadata?: AiAuditJsonObject;
}

/**
 * Run one inline-AI stream and resolve with the full text once `onDone` fires.
 * Always tears down the underlying Tauri listeners before resolving — without
 * this, every call leaks 3 listeners (regression of commit 337521c).
 *
 * The `settled`+`cleanup` pair handles the (theoretical) race where callbacks
 * fire before the awaited `sendInlineAiStream` Promise resolves.
 */
export function streamInlineAiText(
  messages: { role: string; content: string }[],
  options: StreamInlineAiTextOptions,
): Promise<InlineAiTextResult> {
  return new Promise((resolve) => {
    const buffer: string[] = [];
    let cleanup: (() => void) | null = null;
    let settled = false;
    const projectScope =
      options.projectId === undefined
        ? useTreeStore.getState().projectId
        : options.projectId;

    const settle = (result: InlineAiTextResult) => {
      if (settled) return;
      settled = true;
      cleanup?.();
      cleanup = null;
      resolve(result);
    };

    sendInlineAiStream(
      messages,
      {
        projectId: projectScope?.trim() || null,
        expectedWorkspacePath: options.auditExpectedWorkspacePath,
        pathId: options.auditPathId,
        operationId: options.auditOperationId,
        metadata: options.auditMetadata,
      },
      {
        onTextDelta: (delta) => {
          buffer.push(delta);
        },
        onDone: (info) => {
          // N4: usageSurface 指定時、生成の usage を台帳に記録する。
          if (options.usageSurface) {
            void recordAiUsage({
              surface: options.usageSurface,
              model: options.model,
              tokensIn: info.inputTokens,
              tokensOut: info.outputTokens,
              costUsd: info.cost ?? null,
              projectId: options.projectId ?? undefined,
            });
          }
          settle({ ok: true, text: buffer.join("") });
        },
        onError: (message) => settle({ ok: false, error: message }),
      },
      {
        model: options.model,
        apiVariant: options.apiVariant,
        provider: options.provider,
        endpointId: options.endpointId,
      },
    )
      .then((c) => {
        if (settled) c();
        else cleanup = c;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        settle({ ok: false, error: msg });
      });
  });
}
