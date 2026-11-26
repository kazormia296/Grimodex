import * as chatApi from "@/features/chat/chatApi";
import { aiFailureText } from "@/features/profile-egress/profileEgressAiStop";
import i18next from "@/lib/i18n";
import { rootCause } from "@/lib/debugLog";
import { isD2aEgressDenied } from "@/lib/tauri";
import type { ProjectContext } from "@/features/chat/contextBuilder";
import { isTruncatedStopReason } from "@/features/chat/agent/agentTypes";
import type { CodexAppItem } from "@/features/chat/codexAppApi";
import { useAiSettingsStore } from "@/features/chat/store";
import { fetchProjectContext as fetchProjectContextAtom } from "@/features/project/contextAtoms";
import { readDocumentRuntimeTarget } from "@/runtime/runtimeDocumentTarget";

// ---------------------------------------------------------------------------
// D-17: Error classification and retry helpers
// ---------------------------------------------------------------------------

/** 429（レート制限）で streaming 送信を自動リトライする最大回数。 */
export const MAX_RATE_LIMIT_RETRIES = 3;

export function classifyError(
  e: unknown,
): "auth" | "rate_limit" | "network" | "context_length" | "unknown" {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized|authentication|api\.key|invalid\.key/i.test(msg))
    return "auth";
  if (/429|rate.?limit|too.?many.?request/i.test(msg)) return "rate_limit";
  if (/network|connect|timeout|fetch|ECONNREFUSED/i.test(msg)) return "network";
  if (
    /AI_CONTEXT_WINDOW_EXCEEDED|OLLAMA_CONTEXT_WINDOW_(?:UNKNOWN|TOO_SMALL)|OllamaContextWindow(?:Unknown|TooSmall)|context.window.exceeded|context.length.exceeded|context allocation is unknown|effective.context.window|maximum.context|token.limit|too.long|content.too.large/i.test(
      msg,
    )
  )
    return "context_length";
  return "unknown";
}

/**
 * The toast text of a failed AI turn: the translated `key` with the error, or,
 * for one of the profile activation's AI terminals, its fixed reason instead
 * of the raw code (NIR-1 DA-2 D-10 (a), DR-DA2-34).
 */
export function aiFailureToastText(key: string, message: string): string {
  return aiFailureText(message) ?? i18next.t(key, { message });
}

/**
 * The chat panel's error of a turn that failed before its transport. A D2a
 * refusal there is often wrapped: the new conversation's `createSession`
 * (`INSERT … RETURNING`, D) is refused as generic SQL and Drizzle's message is
 * the statement with its params. It shows `rootCause`'s generic text instead,
 * never the statement, the params nor the raw marker (Negative (11);
 * DR-DA2B-R5). Any other error keeps its message.
 */
export function turnErrorText(error: unknown): string {
  if (isD2aEgressDenied(error)) return rootCause(error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Web Editor sessions must not inherit the desktop-only database model
 * default. An empty string records the truthful "not configured yet" state;
 * native runtimes keep omitting the column so their established default is
 * unchanged.
 */
export function createSessionForCurrentRuntime(
  projectId: string,
  title: string,
  nodeId?: string,
  codexAnchorId?: string,
  snippetAnchorId?: string,
) {
  const webModel =
    readDocumentRuntimeTarget() === "web"
      ? (useAiSettingsStore.getState().settings?.model ?? "")
      : undefined;
  if (webModel === undefined) {
    return chatApi.createSession(
      projectId,
      title,
      nodeId,
      codexAnchorId,
      snippetAnchorId,
    );
  }
  return chatApi.createSession(
    projectId,
    title,
    nodeId,
    codexAnchorId,
    snippetAnchorId,
    webModel,
  );
}

/**
 * user メッセージの `metadata` 文字列 (JSON) から `mentioned_scene_ids`
 * を取り出すヘルパー。regenerate 経路で per-message pin を復元するために
 * 使う。JSON parse 失敗・配列でない・空配列はすべて undefined を返す。
 */
export function parseMentionedSceneIdsFromMetadata(
  metadata: string | null | undefined,
): string[] | undefined {
  if (!metadata) return undefined;
  try {
    const obj = JSON.parse(metadata) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const ids = (obj as Record<string, unknown>).mentioned_scene_ids;
      if (Array.isArray(ids)) {
        const filtered = ids.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        return filtered.length > 0 ? filtered : undefined;
      }
    }
  } catch {
    // JSON parse 失敗は単に未指定として扱う
  }
  return undefined;
}

// Project language remains transport/session metadata; context preparation
// itself resolves the project through the application composition.
export async function fetchProjectContext(
  projectId: string | null,
): Promise<ProjectContext | null> {
  return fetchProjectContextAtom(projectId);
}

export async function fetchRequiredProjectContext(
  projectId: string,
): Promise<ProjectContext> {
  const project = await fetchProjectContext(projectId);
  if (!project) {
    throw new Error("required project context is unavailable");
  }
  return project;
}
export {
  ChatTurnPersistenceError,
  createRetryableCompletedTurnPersistence,
} from "./chatTurnPersistence";

// 出典用の assistant 行の予約（書き込み tool の直前に作り、完了時に更新する）。
export {
  createAssistantRowReservation,
  sendableHistory,
  parseMetadataRecord,
} from "./chatAssistantRowReservation";

export { isTruncatedStopReason };

/**
 * Agent の turn の後に出す「続行」の理由。上限で打ち切られた turn には出し、
 * 質問上限(ask_user)は対象外（回答待ちで止まるので新予算で再開しても無意味）。
 * 出力の打ち切りの続行は `outputContinuable`（Agent モードで停止していない turn）
 * のときだけ出す。続行は Agent モードを強制するので、道具の無い公開の Web 検索の
 * turn に出すと作品を読む経路に変わる。
 */
export function agentContinuationReason(
  result: { outputTruncated: boolean; stoppedReason: string },
  outputContinuable: boolean,
): "output" | "limit" | null {
  if (result.outputTruncated) return outputContinuable ? "output" : null;
  return result.stoppedReason === "limit_calls" ||
    result.stoppedReason === "limit_tokens"
    ? "limit"
    : null;
}

/**
 * stream の応答の行の metadata。thinking、codex app-server の記録、停止と
 * 出力の打ち切りの印をまとめる。何も無ければ undefined。
 */
export function streamAssistantMetadata(input: {
  stopReason: string;
  thinking: string;
  codex: {
    threadId: string | undefined;
    turnId: string | undefined;
    items: Map<string, CodexAppItem>;
    warnings: string[];
  } | null;
}): string | undefined {
  const metadataObj: Record<string, unknown> = {};
  if (input.thinking) {
    metadataObj.thinking_blocks = [{ thinking: input.thinking }];
  }
  const codex = input.codex;
  if (codex) {
    metadataObj.runtime = "codex-app-server";
    metadataObj.usage_source = "app-server";
    metadataObj.stop_reason = input.stopReason;
    if (codex.threadId) metadataObj.codex_thread_id = codex.threadId;
    if (codex.turnId) metadataObj.codex_turn_id = codex.turnId;
    if (codex.items.size > 0) {
      metadataObj.codex_item_ids = [...codex.items.keys()];
      metadataObj.codex_items = [...codex.items.values()].map((item) => {
        const safeItem = { ...item };
        delete safeItem.raw;
        return safeItem;
      });
    }
    if (codex.warnings.length > 0) {
      metadataObj.codex_warnings = codex.warnings;
    }
  }
  if (input.stopReason === "stopped") {
    metadataObj.stopped = true;
  }
  if (isTruncatedStopReason(input.stopReason)) {
    metadataObj.output_truncated = true;
  }
  return Object.keys(metadataObj).length > 0
    ? JSON.stringify(metadataObj)
    : undefined;
}
