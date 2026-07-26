import { useRef, useState } from "react";
import {
  createEditorMutationGate,
  type EditorMutationGate,
} from "./mutationGate";

export interface EditorDocumentSession {
  mutationGate: EditorMutationGate;
  isDirty: boolean;
  isSaving: boolean;
  loadedPhaseId: string | null;
  isDirtyRef: React.MutableRefObject<boolean>;
  setDirtyRef: React.MutableRefObject<(dirty: boolean) => void>;
  setSaving: (saving: boolean) => void;
  setLoadedPhaseId: (phaseId: string | null) => void;
}

/**
 * React-facing session state. The mutation rules themselves stay in the
 * non-React EditorMutationGate so async save/load behavior remains directly
 * testable.
 */
export function useEditorDocumentSession(): EditorDocumentSession {
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadedPhaseId, setLoadedPhaseId] = useState<string | null>(null);
  const mutationGateRef = useRef<EditorMutationGate | null>(null);
  if (mutationGateRef.current === null) {
    mutationGateRef.current = createEditorMutationGate();
  }
  const mutationGate = mutationGateRef.current;
  const isDirtyRef = useRef(false);
  const setDirtyRef = useRef<(dirty: boolean) => void>(() => {});
  setDirtyRef.current = (dirty: boolean) => {
    if (dirty) mutationGate.markEdited();
    isDirtyRef.current = dirty;
    setIsDirty(dirty);
  };

  return {
    mutationGate,
    isDirty,
    isSaving,
    loadedPhaseId,
    isDirtyRef,
    setDirtyRef,
    setSaving: setIsSaving,
    setLoadedPhaseId,
  };
}
