import { useAiSettingsStore } from "@/features/chat/store";
import { DEFAULT_AI_SETTINGS } from "@/features/chat/types";

/**
 * AI の表示の門を「準備できた」状態にする（準備中は方針より先に pending を返し、
 * 入口を隠さない）。
 */
export function setAiProviderReady(): void {
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: "ollama",
      model: "test-model",
      ollamaEndpoint: "http://127.0.0.1:11434",
    },
  });
}
