interface Tab {
  id: string;
  label: string;
  testId: string;
}

interface DetailTabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export function DetailTabs({ tabs, activeTab, onTabChange }: DetailTabsProps) {
  return (
    <div className="flex shrink-0 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-testid={tab.testId}
          onClick={() => onTabChange(tab.id)}
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === tab.id
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
