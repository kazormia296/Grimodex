import type { AiAuditExecutionHandle } from "@/features/ai-audit/types";

type SingleShotTransportModule = typeof import("./singleShotTransport");
type ChatStreamTransportModule = typeof import("./chatStreamTransport");

export function loadSingleShotTransport(): Promise<SingleShotTransportModule> {
  return import("./singleShotTransport");
}

export async function loadAiAuditRuntime() {
  const [auditApi, auditTransport, singleShotTransport] = await Promise.all([
    import("@/features/ai-audit/api"),
    import("@/features/ai-audit/transportContext"),
    loadSingleShotTransport(),
  ]);
  return { ...auditApi, ...auditTransport, ...singleShotTransport };
}

// 読み込みの箇所を 1 つにする。箇所ごとに vite の依存の一覧が起動時の chunk に複製される。
const loadChatStreamTransport = () => import("./chatStreamTransport");

export const sendChatMessageStream: ChatStreamTransportModule["sendChatMessageStream"] =
  async (...args) =>
    (await loadChatStreamTransport()).sendChatMessageStream(...args);

export const abortChatStream: ChatStreamTransportModule["abortChatStream"] =
  async (...args) => (await loadChatStreamTransport()).abortChatStream(...args);

export async function runStoppableAgentSend<T>(
  signal: AbortSignal | undefined,
  audit: AiAuditExecutionHandle,
  send: () => Promise<T>,
): Promise<T> {
  const transport = await loadChatStreamTransport();
  return transport.runStoppableAgentSend(signal, audit, send);
}
