import type { LucideIcon } from "lucide-react";

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

/**
 * Codex 詳細パネルのタブ列。
 *
 * 各タブは常に icon + ラベルを表示する。タブ数が増えて 1 行に収まらない狭い
 * 幅では横スクロールへ退避する（`overflow-x-auto`）。
 *
 * 以前は `useFitsInline` で幅を測り、収まらない時はアクティブ以外のラベルを
 * 隠していたが、タブが 5→8 に増えた結果ふつうのパネル幅でも閾値を超え、
 * 「広げてもラベルが出ない」状態になっていた。タブはナビゲーションであり
 * 名称が常に見える方が望ましいので、畳まず常時ラベル + 横スクロールにする。
 */
export function DetailTabs({ tabs, activeTab, onTabChange }: DetailTabsProps) {
  return (
    <div className="flex shrink-0 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
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
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
