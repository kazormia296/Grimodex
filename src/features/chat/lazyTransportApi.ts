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

export const sendChatMessageStream: ChatStreamTransportModule["sendChatMessageStream"] =
  async (...args) => {
    const { sendChatMessageStream: send } =
      await import("./chatStreamTransport");
    return send(...args);
  };

export const abortChatStream: ChatStreamTransportModule["abortChatStream"] =
  async (...args) => {
    const { abortChatStream: abort } = await import("./chatStreamTransport");
    return abort(...args);
  };
