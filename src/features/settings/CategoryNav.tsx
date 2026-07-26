import { cn } from "@/lib/utils";
import { SETTINGS_CATEGORIES, type SettingsCategory } from "./types";
import { useLicenseStore } from "@/features/license/store";
import { UpdateDot } from "@/features/updater/UpdateDot";

interface CategoryNavProps {
  active: SettingsCategory;
  onChange: (cat: SettingsCategory) => void;
  phoneWorkspace?: boolean;
}

export function CategoryNav({
  active,
  onChange,
  phoneWorkspace = false,
}: CategoryNavProps) {
  // licensing 無効ビルド (ベータ) では License カテゴリを出さない (設計書 §9.1)。
  const licensingEnabled = useLicenseStore((s) => s.licensingEnabled);
  const categories = SETTINGS_CATEGORIES.filter(
    ({ id }) => id !== "license" || licensingEnabled,
  );
  return (
    <nav
      aria-label="Settings"
      data-phone-category-nav={phoneWorkspace ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-shrink-0 gap-0.5 border-border p-2",
        phoneWorkspace
          ? "w-full overscroll-x-contain overflow-x-auto border-b"
          : "w-[120px] flex-col border-r",
      )}
    >
      {categories.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "flex min-h-11 items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
            phoneWorkspace && "shrink-0 whitespace-nowrap",
            active === id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span>{label}</span>
          {id === "about" && <UpdateDot className="ml-auto" />}
        </button>
      ))}
    </nav>
  );
}
