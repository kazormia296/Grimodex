import { useId } from "react";
import { motion } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { cn } from "@/lib/utils";
import { SETTINGS_CATEGORIES, type SettingsCategory } from "./types";
import { useLicenseStore } from "@/features/license/store";
import { UpdateDot } from "@/features/updater/UpdateDot";

interface CategoryNavProps {
  active: SettingsCategory;
  onChange: (cat: SettingsCategory) => void;
  phoneWorkspace?: boolean;
  /**
   * ダイアログを開き直したときに変わる番号。選択中の背景は、同じ番号の間の
   * 切替だけ前の位置から滑る（開き直したときに前回の位置から飛んでこない）。
   * mount し直したときは layoutId の useId が変わるので、そちらでも切れる。
   */
  motionScope?: number;
}

export function CategoryNav({
  active,
  onChange,
  phoneWorkspace = false,
  motionScope = 0,
}: CategoryNavProps) {
  const navId = useId();
  const reduced = useReducedMotion();
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
        // isolate: 選択中の背景（-z-10）を、どのボタンの文字よりも下に置く。
        // 背景が途中のボタンの上を通っても文字を隠さない。
        "isolate flex min-w-0 flex-shrink-0 gap-0.5 border-border p-2",
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
            "relative flex min-h-11 items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
            phoneWorkspace && "shrink-0 whitespace-nowrap",
            active === id
              ? "text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {active === id && (
            <motion.span
              // 開き直すたびに新しい layoutId に載せる。
              key={motionScope}
              aria-hidden
              data-settings-category-pill
              layoutId={`settings-category:${navId}:${motionScope}`}
              layoutDependency={active}
              className="pointer-events-none absolute inset-0 -z-10 rounded bg-accent"
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: DURATIONS.normal, ease: EASINGS.easeOut }
              }
            />
          )}
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span>{label}</span>
          {id === "about" && <UpdateDot className="ml-auto" />}
        </button>
      ))}
    </nav>
  );
}
