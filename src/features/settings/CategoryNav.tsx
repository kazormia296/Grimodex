import { cn } from "@/lib/utils";
import { SETTINGS_CATEGORIES, type SettingsCategory } from "./types";
import { useLicenseStore } from "@/features/license/store";

interface CategoryNavProps {
  active: SettingsCategory;
  onChange: (cat: SettingsCategory) => void;
}

export function CategoryNav({ active, onChange }: CategoryNavProps) {
  // licensing 無効ビルド (ベータ) では License カテゴリを出さない (設計書 §9.1)。
  const licensingEnabled = useLicenseStore((s) => s.licensingEnabled);
  const categories = SETTINGS_CATEGORIES.filter(
    ({ id }) => id !== "license" || licensingEnabled,
  );
  return (
    <nav className="flex w-[120px] flex-shrink-0 flex-col gap-0.5 border-r border-border p-2">
      {categories.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
            active === id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
