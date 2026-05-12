import { useProjectSettings } from "@/features/settings/hooks/useProjectSettings";
import { parseAiPolicy } from "./parse";
import type { AiPolicy } from "./types";

/**
 * 現在のプロジェクトの AI 使用方針を返す。
 * プロジェクト未ロード時は null (= pending)。
 *
 * NOTE: useProjectSettings はマウントごとに個別 fetch する設計。
 * Phase 2 で複数箇所から useAiCapability を呼ぶと N+1 fetch が発生し得るため、
 * Phase 2 着手時に zustand ストア化を再検討すること。
 */
export function useCurrentProjectAiPolicy(): AiPolicy | null {
  const { project, isLoading } = useProjectSettings();
  if (isLoading || !project) return null;
  return parseAiPolicy(project.aiPolicy);
}
