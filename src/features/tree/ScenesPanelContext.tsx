import { createContext, useContext } from "react";

interface ScenesPanelContextValue {
  openManageLabels: () => void;
}

export const ScenesPanelContext = createContext<ScenesPanelContextValue | null>(
  null,
);

export function useScenesPanelContext(): ScenesPanelContextValue | null {
  return useContext(ScenesPanelContext);
}
