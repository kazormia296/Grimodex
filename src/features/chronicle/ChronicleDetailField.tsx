import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { CodexContentEditor } from "@/features/codex/components/CodexContentEditor";
import { useTabStore } from "@/features/editor/tabStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { EventRow } from "./api";

interface ChronicleDetailFieldProps {
  event: EventRow;
  /** 詳細を patch 保存する（ChroniclePanel.handlePatch 経由の tracked-write）。 */
  onPatchDetail: (detail: string) => void;
}

/**
 * 出来事インスペクタの「詳細」欄。Codex 説明欄と同じ TipTap ミニエディタ
 * （Codex ハイライト・ProseMirror JSON 保存）を再利用する。右上「エディタで開く」
 * で本文用 EditorPane タブに展開できる。
 *
 * `content` prop は初期値のみで、以後の反映は CodexContentEditor 内の live-sync
 * （sceneContentStore）が担う。親は `key={event.id}` で出来事切替時に remount し、
 * 初期 content を更新すること。
 */
export function ChronicleDetailField({
  event,
  onPatchDetail,
}: ChronicleDetailFieldProps) {
  const { t } = useTranslation();
  // 最新のシリアライズ済み content を保持し、autosave が stale を書かないようにする。
  const contentRef = useRef(event.detail ?? "");

  const save = useCallback(async () => {
    onPatchDetail(contentRef.current);
  }, [onPatchDetail]);

  const { schedule } = useAutoSave(save, 2000);

  const handleContentChange = useCallback(
    (content: string) => {
      contentRef.current = content;
      schedule();
    },
    [schedule],
  );

  // EditorPane タブ側の編集を contentRef に反映（次回 autosave での巻き戻し防止）。
  const handleExternalSync = useCallback((content: string) => {
    contentRef.current = content;
  }, []);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-foreground">
          {t("chronicle.detail.label", "詳細")}
        </label>
        <button
          type="button"
          onClick={() =>
            useTabStore.getState().openChronicleEventTab(event.id, event.title)
          }
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          title={t("chronicle.detail.openInEditor", "エディタで開く")}
        >
          <ExternalLink className="h-3 w-3" />
          {t("chronicle.detail.openInEditor", "エディタで開く")}
        </button>
      </div>
      <CodexContentEditor
        content={event.detail ?? ""}
        onContentChange={handleContentChange}
        entryId={event.id}
        entryKind="chronicle_event"
        onExternalSync={handleExternalSync}
      />
    </div>
  );
}
