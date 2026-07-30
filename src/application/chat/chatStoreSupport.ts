import * as chatApi from "@/features/chat/chatApi";
import type { ProjectContext } from "@/features/chat/contextBuilder";
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
