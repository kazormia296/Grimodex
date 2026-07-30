import { X } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";
import { SynopsisHeader } from "@/features/editor/SynopsisHeader";
import { BeatsHeader } from "@/features/editor/BeatsHeader";
import { ScenePropertyGrid } from "@/features/editor/sceneMeta/ScenePropertyGrid";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSettingsStore } from "@/features/settings/settingsStore";

interface SceneMetaPanelProps {
  sceneId: string;
  editor: Editor | null;
  setMentionPopup: (state: CodexMentionPopupState | null) => void;
  embeddedInPhoneSheet?: boolean;
}

/**
 * シーン詳細パネル (Editorパネル Refine 1f)。
 * ヘッダ（タイトル + status バッジ + 閉じる）/ プロパティグリッド
 * （視点・場所・作中日付 = チップ + ポップオーバー）/ あらすじ・狙い /
 * ビートの縦積み。開閉状態は editor.sceneMetaPanelOpen 設定
 * （EditorPane / LinearEditorView 双方のトグルと同一ソース）。
 */
export function SceneMetaPanel({
  sceneId,
  editor,
  setMentionPopup,
  embeddedInPhoneSheet = false,
}: SceneMetaPanelProps) {
  const { t } = useTranslation();
  const node = useTreeStore((s) => s.nodes.find((n) => n.id === sceneId));
  const isScene = node?.nodeType === "scene";
  return (
    <div
      data-testid="scene-meta-panel"
      data-editor-tool-surface
      className="flex h-full w-full flex-col overflow-y-auto border-l border-border bg-muted/20"
    >
      <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-border px-3">
        <span className="text-[11px] font-bold text-foreground">
          {t("editor.sceneDetail.title")}
        </span>
        {isScene && node?.status && (
          <span className="rounded bg-primary/10 px-1.5 py-px text-[9px] font-bold text-primary">
            {t(`editor.status.${node.status}`)}
          </span>
        )}
        {!embeddedInPhoneSheet && (
          <button
            type="button"
            data-testid="scene-meta-panel-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={() =>
              useSettingsStore
                .getState()
                .set("editor.sceneMetaPanelOpen", "false")
            }
            className="ms-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {isScene && node && <ScenePropertyGrid node={node} />}
      <SynopsisHeader sceneId={sceneId} editor={editor} />
      <BeatsHeader
        sceneId={sceneId}
        editor={editor}
        setMentionPopup={setMentionPopup}
      />
    </div>
  );
}
