/**
 * 試験だけが使う。編集して再送の閉鎖（DR-DA2B-R29）の試験で、AI の設定を送信の capture の
 * 内（loopback の OpenAI 互換、native tool）か外（cloud の provider、loopback でない
 * OpenAI 互換）にする。`chatStore.test.ts` の `configurePlainCaptureTurn` と同じ設定。
 */
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "./store";

export const CAPTURE_LOOPBACK_BASE_URL = "http://127.0.0.1:12345/v1";

export function configureOpenaiCompatibleRoute(
  baseUrl: string = CAPTURE_LOOPBACK_BASE_URL,
): void {
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: "openai-compatible",
      model: "local-test-model",
      modelApiVariant: null,
      toolProtocolMode: "native",
      openaiCompatibleEndpoints: [
        {
          id: "local-endpoint",
          label: "Local endpoint",
          baseUrl,
          customMaxContext: 16_384,
          customMaxOutput: 1_024,
        },
      ],
      activeOpenaiCompatibleEndpointId: "local-endpoint",
    },
    chatModelOverride: null,
    models: [],
  });
}

/** capture の外の cloud の route（Anthropic）。 */
export function configureCloudRoute(): void {
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    },
    chatModelOverride: null,
    models: [],
  });
}
