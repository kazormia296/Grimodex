import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import { serializeAiPolicy } from "@/features/ai-policy/parse";
import { DEFAULT_AI_POLICY } from "@/features/ai-policy/types";

/**
 * AI の書き込みの門を通る試験のために、現在の作品を全部許可の利用方針で store に
 * 置く（作品が読み込まれていない間、書き込みの 3 軸は止まる）。
 */
export function seedWritableProject(): void {
  const id = getCurrentProjectId();
  useProjectStore.setState((state) => ({
    projects: [
      ...state.projects.filter((project) => project.id !== id),
      {
        id,
        title: "Test",
        aiPolicy: serializeAiPolicy(DEFAULT_AI_POLICY),
      } as never,
    ],
  }));
}
