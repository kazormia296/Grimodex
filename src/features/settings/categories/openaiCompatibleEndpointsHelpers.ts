import type {
  AiSettings,
  OpenaiCompatibleEndpoint,
} from "@/features/chat/types";

/**
 * 複数 OpenAI 互換エンドポイントの list / activeId 操作の純ロジック。
 *
 * UI (OpenaiCompatibleEndpointsManager) と AiCategory の保存処理は keyring などの
 * I/O を伴うが、配列の add / delete / 既定切替・legacy ミラーといった計算部分は
 * ここに切り出して単体テスト可能にしている（I/O は呼び出し側）。
 */

/** 新規追加するエンドポイントの初期値。id は crypto.randomUUID() で採番。 */
export function makeNewEndpoint(): OpenaiCompatibleEndpoint {
  return {
    id: crypto.randomUUID(),
    label: "",
    baseUrl: "",
    apiVariant: null,
  };
}

/** 1 件追記して返す（list は破壊しない）。 */
export function addEndpoint(
  list: OpenaiCompatibleEndpoint[],
  endpoint: OpenaiCompatibleEndpoint,
): OpenaiCompatibleEndpoint[] {
  return [...list, endpoint];
}

/** patch を id 一致のエンドポイントへマージして返す。 */
export function updateEndpoint(
  list: OpenaiCompatibleEndpoint[],
  id: string,
  patch: Partial<OpenaiCompatibleEndpoint>,
): OpenaiCompatibleEndpoint[] {
  return list.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

/**
 * id のエンドポイントを除いた新 list と、削除後の activeId を返す。
 * 削除したのが active だった場合は残りの先頭へフォールバック（無ければ null）。
 */
export function removeEndpoint(
  list: OpenaiCompatibleEndpoint[],
  activeId: string | null | undefined,
  id: string,
): { list: OpenaiCompatibleEndpoint[]; activeId: string | null } {
  const next = list.filter((e) => e.id !== id);
  let nextActive: string | null = activeId ?? null;
  if (activeId === id || !next.some((e) => e.id === nextActive)) {
    nextActive = next.length > 0 ? next[0].id : null;
  }
  return { list: next, activeId: nextActive };
}

/**
 * 保存時に書き戻す AiSettings の差分。
 * - openaiCompatibleEndpoints / activeOpenaiCompatibleEndpointId を更新。
 * - 既定（active）エンドポイントの {baseUrl, customMaxContext, customMaxOutput,
 *   enableStructuredTasks} を legacy `openaiCompatible` へミラー（旧ビルドへの
 *   downgrade 安全性確保。エンドポイントが無ければ baseUrl だけ空にして温存）。
 */
export function applyEndpointsToSettings(
  settings: AiSettings,
  list: OpenaiCompatibleEndpoint[],
  activeId: string | null,
): AiSettings {
  const active =
    list.find((e) => e.id === activeId) ?? (list.length > 0 ? list[0] : null);
  const legacy = active
    ? {
        baseUrl: active.baseUrl,
        customMaxContext: active.customMaxContext,
        customMaxOutput: active.customMaxOutput,
        enableStructuredTasks: active.enableStructuredTasks,
      }
    : { ...settings.openaiCompatible, baseUrl: "" };
  return {
    ...settings,
    openaiCompatibleEndpoints: list,
    activeOpenaiCompatibleEndpointId: active ? active.id : null,
    openaiCompatible: legacy,
  };
}
