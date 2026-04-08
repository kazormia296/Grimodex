import { useRef } from "react";
import { EntryIcon } from "./EntryIcon";
import { resizeAndConvertToWebP } from "../iconUtils";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await resizeAndConvertToWebP(file);
    onIconChange(result);
    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const hasIcon = currentIcon != null && currentIcon.startsWith("data:");

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="group relative block rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
          title="アイコンを変更"
        >
          <EntryIcon icon={currentIcon} entryType={entryType} size={48} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            変更
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
      {hasIcon && (
        <button
          type="button"
          onClick={() => onIconChange(null)}
          className="text-xs text-destructive hover:underline"
        >
          削除
        </button>
      )}
    </div>
  );
}
