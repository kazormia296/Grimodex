import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  useResultsPanelStore,
  type SearchTypeFilter,
  type SourceFilter,
} from "./store/resultsPanelStore";

const SOURCE_OPTIONS: { value: SourceFilter; key: string; fallback: string }[] =
  [
    { value: "all", key: "commandCenter.filter.all", fallback: "すべて" },
    { value: "scene", key: "commandCenter.filter.scene", fallback: "Scene" },
    { value: "codex", key: "commandCenter.filter.codex", fallback: "Codex" },
    {
      value: "snippet",
      key: "commandCenter.filter.snippet",
      fallback: "Snippet",
    },
  ];

const TYPE_OPTIONS: {
  value: SearchTypeFilter;
  key: string;
  fallback: string;
}[] = [
  { value: "all", key: "commandCenter.filter.all", fallback: "すべて" },
  {
    value: "lexical",
    key: "commandCenter.filter.lexical",
    fallback: "Lexical",
  },
  {
    value: "semantic",
    key: "commandCenter.filter.semantic",
    fallback: "Semantic",
  },
];

interface FilterGroupProps<V extends string> {
  label: string;
  current: V;
  onChange: (v: V) => void;
  options: { value: V; key: string; fallback: string }[];
}

function FilterGroup<V extends string>({
  label,
  current,
  onChange,
  options,
}: FilterGroupProps<V>) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <div className="flex gap-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded px-1.5 py-0.5 text-xs transition-colors",
              current === opt.value
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {t(opt.key, { defaultValue: opt.fallback })}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CommandCenterFilterBar() {
  const { t } = useTranslation();
  const sourceFilter = useResultsPanelStore((s) => s.sourceFilter);
  const searchTypeFilter = useResultsPanelStore((s) => s.searchTypeFilter);
  const setSourceFilter = useResultsPanelStore((s) => s.setSourceFilter);
  const setSearchTypeFilter = useResultsPanelStore(
    (s) => s.setSearchTypeFilter,
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-background/40 px-3 py-2">
      <FilterGroup
        label={t("commandCenter.filter.sourceLabel", {
          defaultValue: "ソース",
        })}
        current={sourceFilter}
        onChange={setSourceFilter}
        options={SOURCE_OPTIONS}
      />
      <FilterGroup
        label={t("commandCenter.filter.typeLabel", { defaultValue: "種別" })}
        current={searchTypeFilter}
        onChange={setSearchTypeFilter}
        options={TYPE_OPTIONS}
      />
    </div>
  );
}
