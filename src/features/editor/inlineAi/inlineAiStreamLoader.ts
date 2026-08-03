type InlineAiStreamingModule = typeof import("./inlineAiStreaming");

/**
 * Keep the audit-heavy streaming transport out of the startup graph. The
 * transport module is awaited before it can begin or dispatch an execution,
 * so its fail-closed audit ordering remains unchanged.
 */
export const sendInlineAiStream: InlineAiStreamingModule["sendInlineAiStream"] =
  async (...args) => {
    const { sendInlineAiStream: send } = await import("./inlineAiStreaming");
    return send(...args);
  };
