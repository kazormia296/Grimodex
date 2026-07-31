import i18next from "@/lib/i18n";
import { useAiSettingsStore } from "./store";

export const AI_SINGLE_SHOT_CLI_UNSUPPORTED =
  "AI_SINGLE_SHOT_CLI_UNSUPPORTED" as const;

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
