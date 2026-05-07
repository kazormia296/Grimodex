import { useState } from "react";
import { X, FolderInput, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGridStore } from "./gridStore";
import { GridChapterPickerContent } from "./GridChapterPickerPopover";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface Props {
  onMoveToChapter: (targetFolderId: string) => void;
  onDelete: () => void;
}

export function GridSelectionToolbar({ onMoveToChapter, onDelete }: Props) {
  const { t } = useTranslation();
  const selectedCount = useGridStore((s) => s.selectedSceneIds.size);
  const clearSelection = useGridStore((s) => s.clearSelection);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (selectedCount < 2) return null;

  return (
    <div className="flex items-center gap-2 border-t bg-muted/60 px-4 py-1.5">
      <span className="text-[12px] font-medium text-foreground/80 select-none">
        {t("grid.selection.count", "{{count}} 件選択中", {
          count: selectedCount,
        })}
      </span>

      <div className="ml-auto flex items-center gap-1">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="xs">
              <FolderInput />
              {t("grid.selection.moveTo", "章に移動…")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-auto min-w-[200px] max-h-60 overflow-y-auto p-1"
          >
            <GridChapterPickerContent
              onSelect={(id) => {
                onMoveToChapter(id);
                setPickerOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="xs"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 />
          {t("grid.selection.delete", "削除")}
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={clearSelection}
          title={t("grid.selection.clear", "選択解除")}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
