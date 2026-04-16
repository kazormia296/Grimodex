import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EntryIcon } from "./EntryIcon";
import { IconCropDialog } from "./IconCropDialog";

interface IconPickerProps {
  currentIcon?: string | null;
  entryType: string;
  onIconChange: (icon: string | null) => void;
}

export function IconPicker({
  currentIcon,
  entryType,
  onIconChange,
}: IconPickerProps) {
  const { t } = useTranslation();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleConfirm = (icon: string | null) => {
    onIconChange(icon);
    setIsDialogOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsDialogOpen(true)}
        className="group relative block rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
        title={t("codex.iconPicker.changeIcon")}
      >
        <EntryIcon icon={currentIcon} entryType={entryType} size={48} />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {t("codex.iconPicker.change")}
        </span>
      </button>

      {isDialogOpen && (
        <IconCropDialog
          currentIcon={currentIcon ?? null}
          entryType={entryType}
          onConfirm={handleConfirm}
          onClose={() => setIsDialogOpen(false)}
        />
      )}
    </>
  );
}
