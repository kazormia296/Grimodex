import { iconToDataUrl } from "../iconUtils";

const TYPE_COLOR_DEFAULTS: Record<string, string> = {
  character: "#534AB7",
  location: "#0F6E56",
  item: "#BA7517",
  lore: "#993C1D",
};

interface EntryIconProps {
  icon?: string | null;
  entryType: string;
  size: 24 | 28 | 48;
}

export function EntryIcon({ icon, entryType, size }: EntryIconProps) {
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

  const bg = TYPE_COLOR_DEFAULTS[entryType] ?? "#888888";
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
