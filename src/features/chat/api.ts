import { invoke } from "@/lib/tauri";
import type { AiSettings, AiModel, AiProvider } from "./types";
import { readDocumentRuntimeTarget } from "@/runtime/runtimeDocumentTarget";

export async function getAiSettings(): Promise<AiSettings> {
  return invoke<AiSettings>("get_ai_settings");
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await invoke("save_ai_settings", { settings });
}

/**
 * API キーを保存する。`endpointId` は OpenAI 互換プロバイダの per-endpoint キーで
 * のみ意味を持つ（その他のプロバイダでは無視され単一キーに保存される）。
 */
export async function saveApiKey(
  provider: AiProvider,
  key: string,
  endpointId?: string | null,
): Promise<void> {
  await invoke("save_api_key", {
    provider,
    key,
    endpointId: endpointId ?? null,
  });
}

/**
 * キーの有無だけを問い合わせる。プレーンテキストのキーは renderer に渡さない
 * (実送信のキー解決は Rust 側が担う) ため、フロントは真偽値のみ必要とする。
 * `endpointId` は OpenAI 互換の per-endpoint キー判定でのみ意味を持つ。
 */
export async function hasApiKey(
  provider: AiProvider,
  endpointId?: string | null,
): Promise<boolean> {
  return invoke<boolean>("has_api_key", {
    provider,
    endpointId: endpointId ?? null,
  });
}

export async function deleteApiKey(
  provider: AiProvider,
  endpointId?: string | null,
): Promise<void> {
  await invoke("delete_api_key", {
    provider,
    endpointId: endpointId ?? null,
  });
}

export async function testAiConnection(
  provider: AiProvider,
  model: string,
  apiVariant?: string | null,
  endpointId?: string | null,
): Promise<string> {
  const [auditApi, auditTransport] = await Promise.all([
    import("@/features/ai-audit/api"),
    import("@/features/ai-audit/transportContext"),
  ]);
  const {
    beginAiAuditExecution,
    completeAiAuditExecution,
    failAiAuditExecution,
    markAiAuditDispatched,
  } = auditApi;
  const { auditErrorSnapshot, beforeIpcDispatchDetails, nativeAiAuditContext } =
    auditTransport;
  const args: Record<string, unknown> = {
    provider,
    model,
    apiVariant: apiVariant ?? null,
    endpointId: endpointId ?? null,
  };
  const runtimeTarget = readDocumentRuntimeTarget() ?? "electron";
  const webRuntime = runtimeTarget === "web";
  const electronRuntime = runtimeTarget === "electron";
  const effectiveRequestReceiptExpected = webRuntime || electronRuntime;
  const maxOutputTokens =
    webRuntime || (provider !== "openai" && provider !== "sakana") ? 32 : 1024;
  const audit = await beginAiAuditExecution({
    projectId: null,
    pathId: "ai_connection_test",
    request: {
      provider,
      model,
      messages: [
        { role: "user", content: "Reply with exactly: Connection OK" },
      ],
      options: {
        apiVariant: apiVariant ?? null,
        endpointId: endpointId ?? null,
        maxOutputTokens,
      },
      auditMetadata: {
        purpose: "connection-test",
        scope: "workspace",
        runtimeTarget,
        providerWireBodyAssemblyBoundary: webRuntime
          ? "browser-ai"
          : runtimeTarget === "mobile-native"
            ? "mobile-native-provider-transport"
            : "electron-native-provider-transport",
        effectiveRequestReceiptObservedAtRendererStart: false,
        effectiveRequestReceiptExpected,
        effectiveRequestReceiptDurabilityBoundary: webRuntime
          ? "browser-ai-before-fetch"
          : electronRuntime
            ? "native-http-observer-before-send"
            : "unavailable",
      },
    },
    ...(effectiveRequestReceiptExpected
      ? { captureState: "complete" as const }
      : {
          captureState: "partial" as const,
          limitations: [
            "mobile-native-effective-request-receipt-uninstrumented",
          ],
        }),
  });
  args.auditContext = nativeAiAuditContext(audit);
  await markAiAuditDispatched(
    audit,
    beforeIpcDispatchDetails("test_ai_connection"),
  );
  try {
    const response = await invoke<string>("test_ai_connection", args);
    await completeAiAuditExecution(audit, {
      response: { text: response },
      metadata: { scope: "workspace", purpose: "connection-test" },
    });
    return response;
  } catch (error) {
    await failAiAuditExecution(audit, { error: auditErrorSnapshot(error) });
    throw error;
  }
}

export async function listAiModels(
  provider: AiProvider,
  endpointId?: string | null,
  selectedModelId?: string | null,
  /** Ollama endpoint expected by the caller's capability-cache scope. */
  expectedOllamaEndpoint?: string | null,
): Promise<AiModel[]> {
  return invoke<AiModel[]>("list_ai_models", {
    provider,
    endpointId: endpointId ?? null,
    selectedModelId: selectedModelId ?? null,
    expectedOllamaEndpoint: expectedOllamaEndpoint ?? null,
  });
}
