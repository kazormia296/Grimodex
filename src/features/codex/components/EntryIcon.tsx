import { useMemo, useEffect } from "react";
import { numberArrayToObjectUrl } from "../iconUtils";

const TYPE_COLOR_DEFAULTS: Record<string, string> = {
  character: "#534AB7",
  location: "#0F6E56",
  item: "#BA7517",
  lore: "#993C1D",
};

interface EntryIconProps {
  icon?: number[] | null;
  entryType: string;
  size: 24 | 28 | 48;
}

export function EntryIcon({ icon, entryType, size }: EntryIconProps) {
  const objectUrl = useMemo(() => numberArrayToObjectUrl(icon), [icon]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  if (objectUrl) {
    return (
      <img
        src={objectUrl}
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
