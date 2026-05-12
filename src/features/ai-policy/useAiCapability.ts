import {
  useAiSettingsStore,
  selectProviderReadiness,
} from "@/features/chat/store";
import { useCurrentProjectAiPolicy } from "./useCurrentProjectAiPolicy";
import type { AiCapability, AiFeature } from "./types";

/**
 * 指定した AI 機能が現在使用可能かを返す中央フック。
 *
 * 判定優先順: pending → policy → no-model → no-provider → enabled
 * ユーザの意思 (policy) を provider 状態より優先させることで、
 * 「Off にしたのに未設定ダイアログが出る」事故を防ぐ。
 */
export function useAiCapability(feature: AiFeature): AiCapability {
  const readiness = useAiSettingsStore(selectProviderReadiness);
  const policy = useCurrentProjectAiPolicy();

  if (readiness === "pending" || policy === null) return { state: "pending" };
  if (!policy.toggles[feature]) return { state: "disabled", reason: "policy" };
  if (readiness === "no-model")
    return { state: "disabled", reason: "no-model" };
  if (readiness === "no-provider")
    return { state: "disabled", reason: "no-provider" };
  return { state: "enabled" };
}
