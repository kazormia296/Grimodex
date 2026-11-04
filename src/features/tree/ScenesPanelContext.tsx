import { createContext, useContext } from "react";

export interface OpenAiTreeArgs {
  mode: "scaffold" | "reorganize";
  /** scope root。null = プロジェクト全体。 */
  rootRef: string | null;
  rootTitle?: string;
}

interface ScenesPanelContextValue {
  openManageLabels: () => void;
  /** AI による tree scaffold/再編ダイアログを開く (案B)。 */
  openAiTree: (args: OpenAiTreeArgs) => void;
  /** SDEF/1 R16: apply the Scope default to a chapter's unset scenes. */
  openChapterScopeDefault?: (args: { folderId: string; title: string }) => void;
}

export const ScenesPanelContext = createContext<ScenesPanelContextValue | null>(
  null,
);

export function useScenesPanelContext(): ScenesPanelContextValue | null {
  return useContext(ScenesPanelContext);
}
