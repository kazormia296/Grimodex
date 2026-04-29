import { useState } from "react";
import { Camera } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconToDataUrl } from "../iconUtils";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { IconCropDialog } from "./IconCropDialog";

const TYPE_COLOR_DEFAULTS: Record<string, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

const PURPLE_DEEP = "#7c3aed";
const SIZE = 76;

interface EntryHeroAvatarProps {
  icon?: string | null;
  entryType: string;
  name: string;
  onIconChange: (icon: string | null) => void;
}

export function EntryHeroAvatar({
  icon,
  entryType,
  name,
  onIconChange,
}: EntryHeroAvatarProps) {
  const { t } = useTranslation();
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const [open, setOpen] = useState(false);

  const dataUrl = iconToDataUrl(icon);
  const baseColor =
    typeColorMap[entryType]?.fg ?? TYPE_COLOR_DEFAULTS[entryType] ?? "#888888";
  const initial = (name?.trim()?.[0] ?? "").toUpperCase();

  const handleConfirm = (newIcon: string | null) => {
    onIconChange(newIcon);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
        title={t("codex.iconPicker.changeIcon")}
        style={{
          width: SIZE,
          height: SIZE,
          boxShadow:
            "0 2px 12px rgba(124,58,237,.35), inset 0 -8px 16px rgba(0,0,0,.2)",
          borderRadius: "50%",
        }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={entryType}
            width={SIZE}
            height={SIZE}
            className="rounded-full"
            style={{ width: SIZE, height: SIZE }}
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
            style={{
              background: `radial-gradient(circle at 35% 30%, ${baseColor}, ${PURPLE_DEEP})`,
              fontSize: Math.round(SIZE * 0.42),
            }}
            aria-label={entryType}
          >
            {initial}
          </span>
        )}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <Camera className="h-5 w-5" />
        </span>
      </button>

      {open && (
        <IconCropDialog
          currentIcon={icon ?? null}
          entryType={entryType}
          onConfirm={handleConfirm}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
