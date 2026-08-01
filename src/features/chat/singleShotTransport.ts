import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { useAiSettingsStore } from "./store";

export const AI_SINGLE_SHOT_CLI_UNSUPPORTED =
  "AI_SINGLE_SHOT_CLI_UNSUPPORTED" as const;

export interface ChatResponsePayload {
  blocks: Array<
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | {
        type: "thinking";
        content: string;
        summary?: string;
        signature?: string;
      }
  >;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * `send_chat_message` is an HTTP-provider command. CLI exec and Codex App
 * Server use their own streaming transports and cannot be sent through it.
 */
export class SingleShotCliUnsupportedError extends Error {
  readonly code = AI_SINGLE_SHOT_CLI_UNSUPPORTED;

  constructor() {
    super(i18next.t("settings.ai.roleModel.cliSingleShotUnsupported"));
    this.name = "SingleShotCliUnsupportedError";
  }
}

/**
 * Fail before IPC with an actionable error instead of letting the Rust HTTP
 * path attempt to use CLI's empty base URL. An explicit role-provider override
 * wins over the active provider, so CLI chat can coexist with an HTTP model for
 * structured/cheap one-shot work.
 */
export function assertSingleShotTransportSupported(
  providerOverride?: string | null,
): void {
  const explicitProvider = providerOverride?.trim();
  const effectiveProvider =
    explicitProvider || useAiSettingsStore.getState().settings?.provider;
  if (effectiveProvider === "cli") {
    throw new SingleShotCliUnsupportedError();
  }
}

export async function invokeSingleShotChat(
  args: Record<string, unknown>,
): Promise<ChatResponsePayload> {
  const provider = typeof args.provider === "string" ? args.provider : null;
  assertSingleShotTransportSupported(provider);
  return invoke<ChatResponsePayload>("send_chat_message", args);
}
