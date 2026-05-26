import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePanelStore } from "./store/commandCenterStore";
import {
  useResultsPanelStore,
  type SearchTypeKind,
  type SourceKind,
} from "./store/resultsPanelStore";

/**
 * パネルの上部に置く除外フィルタ。クリックで除外トグル (multi-select)。
 *
 * Editor の Toolbar (features/editor/Toolbar.tsx) と同じ overflow パターン:
 * - 各「ユニット」(Source 群 / Type 群) の幅を測定して、container 幅に収まる
 *   数を `visibleUnitCount` で決定。あふれたユニットはケバブメニューに移す。
 * - `descriptionMode` は常時ケバブメニュー内に格納 (頻度が低く、ヘッダー幅を圧迫しないため)。
 */

const SOURCE_OPTIONS: { value: SourceKind; key: string; fallback: string }[] = [
  { value: "scene", key: "commandCenter.filter.scene", fallback: "Scene" },
  { value: "codex", key: "commandCenter.filter.codex", fallback: "Codex" },
  {
    value: "snippet",
    key: "commandCenter.filter.snippet",
    fallback: "Snippet",
  },
];

const TYPE_OPTIONS: { value: SearchTypeKind; key: string; fallback: string }[] =
  [
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

interface ToggleButtonProps {
  excluded: boolean;
  label: string;
  onClick: () => void;
  includedHint: string;
  excludedHint: string;
}

function ToggleButton({
  excluded,
  label,
  onClick,
  includedHint,
  excludedHint,
}: ToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!excluded}
      title={excluded ? excludedHint : includedHint}
      className={cn(
        "rounded px-1.5 py-0.5 text-xs transition-colors",
        excluded
          ? "bg-destructive/20 text-muted-foreground/70 line-through"
          : "bg-accent text-foreground hover:bg-accent/80",
      )}
    >
      {label}
    </button>
  );
}

interface FilterGroupProps<V extends string> {
  label: string;
  excluded: V[];
  onToggle: (v: V) => void;
  options: { value: V; key: string; fallback: string }[];
}

function FilterGroup<V extends string>({
  label,
  excluded,
  onToggle,
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
          <ToggleButton
            key={opt.value}
            excluded={excluded.includes(opt.value)}
            label={t(opt.key, { defaultValue: opt.fallback })}
            onClick={() => onToggle(opt.value)}
            includedHint={t("commandCenter.filter.includedHint", {
              defaultValue: "クリックで除外",
            })}
            excludedHint={t("commandCenter.filter.excludedHint", {
              defaultValue: "クリックで表示",
            })}
          />
        ))}
      </div>
    </div>
  );
}

export function CommandCenterFilterBar() {
  const { t } = useTranslation();
  const excludedSources = useResultsPanelStore((s) => s.excludedSources);
  const excludedTypes = useResultsPanelStore((s) => s.excludedTypes);
  const toggleSource = useResultsPanelStore((s) => s.toggleSource);
  const toggleType = useResultsPanelStore((s) => s.toggleType);
  const descriptionMode = usePanelStore((s) => s.descriptionMode);
  const setDescriptionMode = usePanelStore((s) => s.setDescriptionMode);

  const containerRef = useRef<HTMLDivElement>(null);
  const unit1Ref = useRef<HTMLDivElement>(null);
  const unit2Ref = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const kebabBtnRef = useRef<HTMLButtonElement>(null);
  const kebabDropdownRef = useRef<HTMLDivElement>(null);
  const unitWidths = useRef<number[]>([0, 0]);
  const [rightGroupWidth, setRightGroupWidth] = useState(0);
  const [visibleUnitCount, setVisibleUnitCount] = useState(2);
  const [kebabOpen, setKebabOpen] = useState(false);

  useLayoutEffect(() => {
    unitWidths.current = [
      unit1Ref.current?.offsetWidth ?? 0,
      unit2Ref.current?.offsetWidth ?? 0,
    ];
  }, []);

  useEffect(() => {
    const el = rightGroupRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setRightGroupWidth(el.offsetWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const recompute = () => {
      if (unit1Ref.current && unit2Ref.current) {
        unitWidths.current = [
          unit1Ref.current.offsetWidth,
          unit2Ref.current.offsetWidth,
        ];
      }
      if (!unitWidths.current.some((w) => w > 0)) return;
      // px-3 padding (12px both sides = 24) + ~16px gap budget
      const available = container.offsetWidth - rightGroupWidth - 24 - 16;
      if (available <= 0) {
        setVisibleUnitCount(0);
        return;
      }
      let sum = 0;
      let count = 0;
      for (const w of unitWidths.current) {
        // 4 = approx gap (gap-x-4 = 16px) but tolerate some slack
        if (sum + w + (count > 0 ? 16 : 0) <= available) {
          sum += w + (count > 0 ? 16 : 0);
          count++;
        } else {
          break;
        }
      }
      setVisibleUnitCount(count);
    };
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    recompute();
    return () => observer.disconnect();
  }, [rightGroupWidth]);

  useEffect(() => {
    if (!kebabOpen) return;
    function close(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !kebabBtnRef.current?.contains(target) &&
        !kebabDropdownRef.current?.contains(target)
      ) {
        setKebabOpen(false);
      }
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [kebabOpen]);

  const sourceLabel = t("commandCenter.filter.sourceLabel", {
    defaultValue: "ソース",
  });
  const typeLabel = t("commandCenter.filter.typeLabel", {
    defaultValue: "種別",
  });
  const sourceOverflowed = visibleUnitCount < 1;
  const typeOverflowed = visibleUnitCount < 2;

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-x-4 gap-y-1.5 overflow-hidden border-b border-border bg-background/40 px-3 py-2"
    >
      <div
        ref={unit1Ref}
        className={cn(
          "flex-shrink-0",
          sourceOverflowed && "invisible h-0 w-0 overflow-hidden",
        )}
      >
        <FilterGroup
          label={sourceLabel}
          excluded={excludedSources}
          onToggle={toggleSource}
          options={SOURCE_OPTIONS}
        />
      </div>
      <div
        ref={unit2Ref}
        className={cn(
          "flex-shrink-0",
          typeOverflowed && "invisible h-0 w-0 overflow-hidden",
        )}
      >
        <FilterGroup
          label={typeLabel}
          excluded={excludedTypes}
          onToggle={toggleType}
          options={TYPE_OPTIONS}
        />
      </div>
      <div
        ref={rightGroupRef}
        className="ml-auto flex flex-shrink-0 items-center"
      >
        <button
          ref={kebabBtnRef}
          type="button"
          onClick={() => setKebabOpen((v) => !v)}
          aria-label={t("commandCenter.filter.moreOptions", {
            defaultValue: "その他のオプション",
          })}
          aria-expanded={kebabOpen}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors",
            kebabOpen
              ? "bg-accent text-foreground"
              : "hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {kebabOpen && (
        <div
          ref={kebabDropdownRef}
          className="absolute right-3 top-full z-50 mt-1 min-w-[220px] space-y-3 rounded border border-border bg-popover px-3 py-2 shadow-md"
        >
          {sourceOverflowed && (
            <FilterGroup
              label={sourceLabel}
              excluded={excludedSources}
              onToggle={toggleSource}
              options={SOURCE_OPTIONS}
            />
          )}
          {typeOverflowed && (
            <FilterGroup
              label={typeLabel}
              excluded={excludedTypes}
              onToggle={toggleType}
              options={TYPE_OPTIONS}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t("commandCenter.filter.descriptionMode", {
                defaultValue: "地の文優先",
              })}
            </span>
            <button
              type="button"
              onClick={() => setDescriptionMode(!descriptionMode)}
              aria-pressed={descriptionMode}
              title={t("commandCenter.filter.descriptionModeHint", {
                defaultValue:
                  "Semantic 検索で会話文の多いチャンクのスコアを下げて地の文を優先する",
              })}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs transition-colors",
                descriptionMode
                  ? "bg-primary/20 text-primary"
                  : "bg-accent text-muted-foreground hover:bg-accent/80 hover:text-foreground",
              )}
            >
              {descriptionMode
                ? t("commandCenter.filter.on", { defaultValue: "ON" })
                : t("commandCenter.filter.off", { defaultValue: "OFF" })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
