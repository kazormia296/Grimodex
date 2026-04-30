import type { Editor } from "@tiptap/core";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";
import { SynopsisHeader } from "@/features/editor/SynopsisHeader";
import { BeatsHeader } from "@/features/editor/BeatsHeader";

interface SceneMetaPanelProps {
  sceneId: string;
  editor: Editor | null;
  setMentionPopup: (state: CodexMentionPopupState | null) => void;
}

export function SceneMetaPanel({
  sceneId,
  editor,
  setMentionPopup,
}: SceneMetaPanelProps) {
  return (
    <div
      data-testid="scene-meta-panel"
      className="flex w-72 flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-muted/20"
    >
      <SynopsisHeader sceneId={sceneId} />
      <BeatsHeader
        sceneId={sceneId}
        editor={editor}
        setMentionPopup={setMentionPopup}
      />
    </div>
  );
}
