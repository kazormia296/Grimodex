import {
  useAiSettingsStore,
  selectProviderReadiness,
} from "@/features/chat/store";
import { useCurrentProjectAiPolicy } from "./useCurrentProjectAiPolicy";
import { evaluateAiCapability } from "./evaluateAiCapability";
import type { AiCapability, AiFeature } from "./types";

/**
 * 指定した AI 機能が現在使用可能かを返す中央フック。
 *
 * 判定ロジックは {@link evaluateAiCapability}（pure・React 非依存）に集約し、
 * このフックは store/policy を引いて渡すだけの薄いラッパー。
 */
export function useAiCapability(feature: AiFeature): AiCapability {
  const readiness = useAiSettingsStore(selectProviderReadiness);
  const policy = useCurrentProjectAiPolicy();
  return evaluateAiCapability(policy, readiness, feature);
}
