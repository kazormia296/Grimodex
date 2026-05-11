import type { Editor } from "@tiptap/core";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";
import { SynopsisHeader } from "@/features/editor/SynopsisHeader";
import { BeatsHeader } from "@/features/editor/BeatsHeader";
import { PostEffectAnnotationPanel } from "@/features/post-effect/PostEffectAnnotationPanel";

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
      className="flex h-full w-full flex-col overflow-y-auto border-l border-border bg-muted/20"
    >
      <SynopsisHeader sceneId={sceneId} editor={editor} />
      <BeatsHeader
        sceneId={sceneId}
        editor={editor}
        setMentionPopup={setMentionPopup}
      />
      <div className="border-t border-border">
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
          整合性チェック
        </div>
        <PostEffectAnnotationPanel sceneId={sceneId} />
      </div>
    </div>
  );
}
