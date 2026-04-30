import { createContext, useContext } from "react";

export interface SceneBeatEditorContextValue {
  /** Scene tree_node id this editor is bound to. */
  sceneId: string;
}

const SceneBeatEditorContext =
  createContext<SceneBeatEditorContextValue | null>(null);

export const SceneBeatEditorContextProvider = SceneBeatEditorContext.Provider;

/**
 * NodeView hook to read the surrounding scene context. Returns null when the
 * NodeView is rendered outside an EditorPane (e.g. in unit tests that don't
 * wire the provider).
 */
export function useSceneBeatEditorContext(): SceneBeatEditorContextValue | null {
  return useContext(SceneBeatEditorContext);
}
