import { useCurrentProject } from "@/features/project/projectStore";
import { parseAiPolicy } from "./parse";
import type { AiPolicy } from "./types";

/**
 * 現在のプロジェクトの AI 使用方針を返す。
 * プロジェクト未ロード時は null (= pending)。
 *
 * projectStore の同期キャッシュ (useCurrentProject) を参照する。これにより
 * (a) マウントごとの個別 fetch (旧 useProjectSettings) による N+1 と、
 * (b) fetch 解決までの pending 窓で hide/show がちらつく問題を解消する。
 * 保存は useProjectSettings.updateField が refreshProjects でキャッシュを
 * 最新化するため、表示用途では fresh。
 */
export function useCurrentProjectAiPolicy(): AiPolicy | null {
  const project = useCurrentProject();
  if (!project) return null;
  return parseAiPolicy(project.aiPolicy);
}
