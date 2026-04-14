import { iconToDataUrl } from "../iconUtils";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";

const TYPE_COLOR_DEFAULTS: Record<string, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

interface EntryIconProps {
  icon?: string | null;
  entryType: string;
  size: 24 | 28 | 48;
}

export function EntryIcon({ icon, entryType, size }: EntryIconProps) {
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const dataUrl = iconToDataUrl(icon);

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        width={size}
        height={size}
        alt={entryType}
        style={{ width: size, height: size, borderRadius: "50%" }}
      />
    );
  }

  const bg =
    typeColorMap[entryType]?.fg ?? TYPE_COLOR_DEFAULTS[entryType] ?? "#888888";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: bg,
        flexShrink: 0,
      }}
      aria-label={entryType}
    />
  );
}
