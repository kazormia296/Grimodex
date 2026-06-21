import type { LucideIcon } from "lucide-react";
import { useFitsInline } from "@/hooks/useFitsInline";

interface Tab {
  id: string;
  label: string;
  testId: string;
  icon: LucideIcon;
}

interface DetailTabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export function DetailTabs({ tabs, activeTab, onTabChange }: DetailTabsProps) {
  const { containerRef, measureRef, fits } = useFitsInline();

  return (
    <div
      ref={containerRef}
      className="relative shrink-0 overflow-hidden border-b border-border"
    >
      {/* 計測用: 全タブを icon+label の自然幅で隠し描画。これが container に
          収まる時だけ全ラベルを表示する。overflow-hidden の親で囲い、
          max-content のはみ出しがスクロールバーを生まないようにする。 */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{ width: "max-content" }}
        className="pointer-events-none invisible absolute left-0 top-0 flex"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <span
              key={tab.id}
              className="flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-medium"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{tab.label}</span>
            </span>
          );
        })}
      </div>

      {/* 表示用タブ列。畳んでも入り切らない極端な幅では横スクロールに退避 */}
      <div className="flex overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          // 十分な幅があれば全タブ icon+label。狭い時はアイコンのみだが、
          // アクティブタブだけは現在地が分かるようラベルを残す。
          const showLabel = fits || isActive;
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={tab.testId}
              onClick={() => onTabChange(tab.id)}
              title={tab.label}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {/* 隠す時も sr-only で a11y ツリーにはラベルを残す */}
              <span className={showLabel ? "" : "sr-only"}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
