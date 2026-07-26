import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { CalendarDays, ChevronDown, MapPin, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { EventPrecision } from "@/db/schema";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useProjectCalendar } from "@/features/chronicle/useProjectCalendar";
import type { ChronicleCalendar } from "@/features/chronicle/chronicleTime";
import { CodexRefPickerPopover } from "./CodexRefPickerPopover";
import { SceneDatePopover } from "./SceneDatePopover";
import { formatSceneDateLabel } from "./sceneDateLabel";

/** Codex 組み込みタイプのドット色 (typeApi.ts BUILTIN_TYPES の seed 値)。 */
export const CHARACTER_DOT_COLOR = "#7F77DD";
export const LOCATION_DOT_COLOR = "#1D9E75";

const FALLBACK_CALENDAR: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
};

type PickerKind = "pov" | "location" | "date";

function PropertyRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-[3px]">
      <span className="flex w-[74px] flex-shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function ChipButton({
  onClick,
  active,
  filled,
  expanded,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  /** 値が設定済みかどうか（未設定はミュート表示）。 */
  filled: boolean;
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "flex max-w-full items-center gap-1.5 rounded-md border px-2 py-[2.5px] text-[11px] transition-colors",
        filled
          ? "border-border bg-background font-medium text-foreground"
          : "border-dashed border-border bg-transparent text-muted-foreground",
        active ? "bg-accent" : "hover:bg-accent",
      )}
    >
      {children}
      <ChevronDown size={9} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * シーン詳細パネル上段のプロパティグリッド (1f)。
 * 視点 / 場所 / 作中日付をチップ + ポップオーバーピッカーで編集する
 * （ネイティブ select の置換）。保存はすべて treeStore アクション経由。
 */
export function ScenePropertyGrid({ node }: { node: TreeNodeData }) {
  const { t, i18n } = useTranslation();
  const [openPicker, setOpenPicker] = useState<PickerKind | null>(null);
  const povChipRef = useRef<HTMLSpanElement>(null);
  const locChipRef = useRef<HTMLSpanElement>(null);
  const dateChipRef = useRef<HTMLSpanElement>(null);

  const entries = useCodexStore((s) => s.entries);
  const updatePovCharacter = useTreeStore((s) => s.updatePovCharacter);
  const updateLocation = useTreeStore((s) => s.updateLocation);
  const { calendar } = useProjectCalendar(node.projectId);

  const characters = entries.filter((e) => e.type === "character");
  const locations = entries.filter((e) => e.type === "location");
  const pov = entries.find((e) => e.id === node.povCharacterId) ?? null;
  const location = entries.find((e) => e.id === node.locationId) ?? null;

  const lang = i18n.language?.startsWith("en") ? "en" : "ja";
  const dateLabel = formatSceneDateLabel(
    node,
    calendar ?? FALLBACK_CALENDAR,
    lang,
  );
  const precision = (node.chroniclePrecision ?? "exact") as EventPrecision;

  const toggle = (kind: PickerKind) =>
    setOpenPicker((cur) => (cur === kind ? null : kind));

  return (
    <div
      data-testid="scene-property-grid"
      className="flex flex-shrink-0 flex-col border-b border-border px-3 py-2"
    >
      <PropertyRow
        icon={<User size={11} aria-hidden />}
        label={t("editor.sceneDetail.pov")}
      >
        <span ref={povChipRef} className="inline-flex max-w-full">
          <ChipButton
            onClick={() => toggle("pov")}
            filled={!!pov}
            expanded={openPicker === "pov"}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: CHARACTER_DOT_COLOR }}
            />
            <span className="min-w-0 truncate">
              {pov?.name ?? t("editor.sceneDetail.notSet")}
            </span>
          </ChipButton>
        </span>
      </PropertyRow>

      <PropertyRow
        icon={<MapPin size={11} aria-hidden />}
        label={t("editor.sceneDetail.location")}
      >
        <span ref={locChipRef} className="inline-flex max-w-full">
          <ChipButton
            onClick={() => toggle("location")}
            filled={!!location}
            expanded={openPicker === "location"}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: LOCATION_DOT_COLOR }}
            />
            <span className="min-w-0 truncate">
              {location?.name ?? t("editor.sceneDetail.notSet")}
            </span>
          </ChipButton>
        </span>
      </PropertyRow>

      <PropertyRow
        icon={<CalendarDays size={11} aria-hidden />}
        label={t("chronicle.sceneDate", "作中日付")}
      >
        <span ref={dateChipRef} className="inline-flex max-w-full">
          <ChipButton
            onClick={() => toggle("date")}
            filled={!!dateLabel}
            expanded={openPicker === "date"}
          >
            <span className="min-w-0 truncate">
              {dateLabel ?? t("editor.sceneDetail.notSet")}
            </span>
            {dateLabel && (
              <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-[8.5px] font-bold text-primary">
                {t(`chronicle.precision.${precision}`, precision)}
              </span>
            )}
          </ChipButton>
        </span>
      </PropertyRow>

      <CodexRefPickerPopover
        open={openPicker === "pov"}
        onClose={() => setOpenPicker(null)}
        triggerRef={povChipRef}
        ariaLabel={t("editor.sceneDetail.pov")}
        searchPlaceholder={t("editor.sceneDetail.searchCharacter")}
        entries={characters}
        value={node.povCharacterId ?? null}
        onSelect={(id) => void updatePovCharacter(node.id, id)}
        dotColor={CHARACTER_DOT_COLOR}
      />
      <CodexRefPickerPopover
        open={openPicker === "location"}
        onClose={() => setOpenPicker(null)}
        triggerRef={locChipRef}
        ariaLabel={t("editor.sceneDetail.location")}
        searchPlaceholder={t("editor.sceneDetail.searchLocation")}
        entries={locations}
        value={node.locationId ?? null}
        onSelect={(id) => void updateLocation(node.id, id)}
        dotColor={LOCATION_DOT_COLOR}
      />
      <SceneDatePopover
        open={openPicker === "date"}
        onClose={() => setOpenPicker(null)}
        triggerRef={dateChipRef}
        node={node}
      />
    </div>
  );
}
