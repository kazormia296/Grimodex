import { useState } from "react";
import { cn } from "@/lib/utils";

const PRESET_COLORS = [
  { value: "#7F77DD", label: "パープル" },
  { value: "#3B82F6", label: "ブルー" },
  { value: "#22C55E", label: "グリーン" },
  { value: "#F97316", label: "オレンジ" },
  { value: "#EC4899", label: "ピンク" },
];

interface SettingColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

export function SettingColorPicker({
  value,
  onChange,
}: SettingColorPickerProps) {
  const [showCustom, setShowCustom] = useState(false);
  const isCustom = !PRESET_COLORS.some((p) => p.value === value);

  return (
    <div className="flex items-center gap-1.5">
      {PRESET_COLORS.map((p) => (
        <button
          key={p.value}
          type="button"
          title={p.label}
          onClick={() => onChange(p.value)}
          className={cn(
            "h-5 w-5 rounded-full border-2 transition-transform hover:scale-110",
            value === p.value ? "border-foreground" : "border-transparent",
          )}
          style={{ backgroundColor: p.value }}
        />
      ))}
      {/* Custom */}
      <button
        type="button"
        title="カスタム"
        onClick={() => setShowCustom(!showCustom)}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-full border-2 text-[9px] transition-transform hover:scale-110",
          isCustom ? "border-foreground" : "border-border",
        )}
        style={isCustom ? { backgroundColor: value } : {}}
      >
        {!isCustom && "＋"}
      </button>
      {showCustom && (
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-5 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
        />
      )}
    </div>
  );
}
