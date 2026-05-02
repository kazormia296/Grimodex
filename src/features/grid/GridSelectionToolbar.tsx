import { useRef, useState } from "react";
import { X, FolderInput, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGridStore } from "./gridStore";
import { GridChapterPickerPopover } from "./GridChapterPickerPopover";

interface Props {
  onMoveToChapter: (targetFolderId: string) => void;
  onDelete: () => void;
}

export function GridSelectionToolbar({ onMoveToChapter, onDelete }: Props) {
  const { t } = useTranslation();
  const selectedCount = useGridStore((s) => s.selectedSceneIds.size);
  const clearSelection = useGridStore((s) => s.clearSelection);
  const [pickerOpen, setPickerOpen] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement>(null);

  if (selectedCount < 2) return null;

  return (
    <div className="relative flex items-center gap-2 border-t bg-muted/60 px-4 py-1.5">
      <span className="text-[12px] font-medium text-foreground/80 select-none">
        {t("grid.selection.count", "{{count}} 件選択中", {
          count: selectedCount,
        })}
      </span>

      <div className="ml-auto flex items-center gap-1">
        <div className="relative">
          <button
            ref={moveButtonRef}
            type="button"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] hover:bg-accent border border-border transition-colors"
            onClick={() => setPickerOpen((v) => !v)}
          >
            <FolderInput className="h-3.5 w-3.5" />
            {t("grid.selection.moveTo", "章に移動…")}
          </button>

          {pickerOpen && (
            <GridChapterPickerPopover
              anchorRef={moveButtonRef}
              onSelect={onMoveToChapter}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        <button
          type="button"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-destructive hover:bg-accent border border-border transition-colors"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("grid.selection.delete", "削除")}
        </button>

        <button
          type="button"
          className="rounded p-1 hover:bg-accent transition-colors"
          onClick={clearSelection}
          title={t("grid.selection.clear", "選択解除")}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
