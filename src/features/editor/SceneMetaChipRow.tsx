import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { EventPrecision } from "@/db/schema";
import { useSettingBoolean } from "@/features/settings/useSettingControl";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useProjectCalendar } from "@/features/chronicle/useProjectCalendar";
import type { ChronicleCalendar } from "@/features/chronicle/chronicleTime";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { countPlacedBeats } from "@/features/editor/beat/beatDocQueries";
import { useEditorStore } from "@/features/editor/editorStore";
import { useTabStore } from "@/features/editor/tabStore";
import {
  CodexRefPickerPopover,
  type CodexRefEntry,
} from "@/features/editor/sceneMeta/CodexRefPickerPopover";
import { SceneDatePopover } from "@/features/editor/sceneMeta/SceneDatePopover";
import { SynopsisChipPopover } from "@/features/editor/sceneMeta/SynopsisChipPopover";
import { formatSceneDateLabel } from "@/features/editor/sceneMeta/sceneDateLabel";
import {
  CHARACTER_DOT_COLOR,
  LOCATION_DOT_COLOR,
} from "@/features/editor/sceneMeta/ScenePropertyGrid";

const FALLBACK_CALENDAR: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
};

type ChipPopover = "pov" | "location" | "date" | "synopsis";

function Chip({
  onClick,
  title,
  expanded,
  outlined,
  children,
}: {
  onClick: () => void;
  title?: string;
  expanded?: boolean;
  /** あらすじチップだけ枠付き白背景 (デザイン 1h)。 */
  outlined?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "flex max-w-60 flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] transition-colors",
        outlined
          ? "border border-border bg-background hover:bg-accent"
          : "bg-muted/60 text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

/**
 * タブバー直下のメタチップ行 (Editorパネル Refine 1h→2b でタブバーと上下入替)。
 * シーン詳細パネルを閉じているときだけ、視点 / 場所 / 作中日付 / あらすじ /
 * ビートを1行のチップで常設する。チップはその場ポップオーバー編集
 * （パネルと同じ共有ピッカー）。ビートチップはパネルを開く。
 *
 * groupIndex 指定時は「そのグループのアクティブタブ = アクティブシーン」の
 * ときだけ描画する（split view で各グループのタブバー直下に置くためのゲート。
 * 同一シーンが両グループで開いている場合はフォーカス中のグループを優先）。
 */
export function SceneMetaChipRow({ groupIndex }: { groupIndex?: 0 | 1 } = {}) {
  const { t, i18n } = useTranslation();
  const [openPopover, setOpenPopover] = useState<ChipPopover | null>(null);
  const povChipRef = useRef<HTMLSpanElement>(null);
  const locChipRef = useRef<HTMLSpanElement>(null);
  const dateChipRef = useRef<HTMLSpanElement>(null);
  const synChipRef = useRef<HTMLSpanElement>(null);

  const node = useTreeStore((s) =>
    s.nodes.find((n) => n.id === s.activeSceneId),
  );
  const sceneId = node?.nodeType === "scene" ? node.id : null;

  const secondaryTabId = useTabStore((s) => s.secondaryActiveTabId);
  const activeGroupIndex = useTabStore((s) => s.activeGroupIndex);

  const { value: panelOpen } = useSettingBoolean(
    "editor.sceneMetaPanelOpen",
    true,
  );

  const entries = useCodexStore((s) => s.entries);
  const { calendar } = useProjectCalendar(node?.projectId ?? null);

  const unplacedCount = useUnplacedBeatsStore((s) =>
    sceneId ? (s.sceneBeats[sceneId]?.length ?? 0) : 0,
  );
  const editor = useEditorStore((s) => s.editor);
  // グローバル editor は primary group (groupIndex 0) のアクティブタブの
  // doc を指す。split view で secondary をフォーカスしているときなど、
  // activeSceneId と一致しない場合は別シーンの doc を数えてしまうため
  // ゲートする（不一致時は配置済みを数えず未配置のみのバッジになる）。
  const primaryTabId = useTabStore((s) => s.activeTabId);
  const [placedCount, setPlacedCount] = useState(0);
  useEffect(() => {
    if (!editor || !sceneId || primaryTabId !== sceneId) {
      setPlacedCount(0);
      return;
    }
    const update = () => setPlacedCount(countPlacedBeats(editor.state.doc));
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor, sceneId, primaryTabId]);

  // フォーカスモードでも隠さない（本文の減光は FocusModePlugin 側で完結する）
  if (!node || !sceneId || panelOpen) return null;

  if (groupIndex !== undefined) {
    const groupTabId = groupIndex === 0 ? primaryTabId : secondaryTabId;
    if (groupTabId !== sceneId) return null;
    // 同一シーンを両グループで開いているときはフォーカス中のグループにだけ出す
    if (
      primaryTabId === sceneId &&
      secondaryTabId === sceneId &&
      groupIndex !== activeGroupIndex
    )
      return null;
  }

  const pov = entries.find((e) => e.id === node.povCharacterId) ?? null;
  const location = entries.find((e) => e.id === node.locationId) ?? null;
  const characters: CodexRefEntry[] = entries.filter(
    (e) => e.type === "character",
  );
  const locations: CodexRefEntry[] = entries.filter(
    (e) => e.type === "location",
  );

  const lang = i18n.language?.startsWith("en") ? "en" : "ja";
  const dateLabel = formatSceneDateLabel(
    node,
    calendar ?? FALLBACK_CALENDAR,
    lang,
  );
  const precision = (node.chroniclePrecision ?? "exact") as EventPrecision;
  const synopsis = node.synopsis?.trim() ?? "";
  const beatCount = unplacedCount + placedCount;

  const toggle = (kind: ChipPopover) =>
    setOpenPopover((cur) => (cur === kind ? null : kind));

  const openPanel = () =>
    useSettingsStore.getState().set("editor.sceneMetaPanelOpen", "true");

  return (
    <div
      data-testid="scene-meta-chip-row"
      className="flex h-7 flex-shrink-0 items-center gap-1.5 overflow-hidden border-b border-border bg-muted/10 px-3"
    >
      <span ref={povChipRef} className="inline-flex min-w-0">
        <Chip
          onClick={() => toggle("pov")}
          expanded={openPopover === "pov"}
          title={t("editor.sceneDetail.pov")}
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: CHARACTER_DOT_COLOR }}
          />
          <span
            className={cn(
              "min-w-0 truncate font-semibold",
              !pov && "font-normal text-muted-foreground",
            )}
          >
            {pov?.name ?? t("editor.sceneDetail.notSet")}
          </span>
        </Chip>
      </span>

      <span ref={locChipRef} className="inline-flex min-w-0">
        <Chip
          onClick={() => toggle("location")}
          expanded={openPopover === "location"}
          title={t("editor.sceneDetail.location")}
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: LOCATION_DOT_COLOR }}
          />
          <span
            className={cn(
              "min-w-0 truncate font-semibold",
              !location && "font-normal text-muted-foreground",
            )}
          >
            {location?.name ?? t("editor.sceneDetail.notSet")}
          </span>
        </Chip>
      </span>

      <span ref={dateChipRef} className="inline-flex min-w-0">
        <Chip
          onClick={() => toggle("date")}
          expanded={openPopover === "date"}
          title={t("chronicle.sceneDate", "作中日付")}
        >
          <CalendarDays
            size={10}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 truncate",
              !dateLabel && "text-muted-foreground",
            )}
          >
            {dateLabel ?? t("editor.sceneDetail.notSet")}
          </span>
          {dateLabel && (
            <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-[8.5px] font-bold text-primary">
              {t(`chronicle.precision.${precision}`, precision)}
            </span>
          )}
        </Chip>
      </span>

      <span ref={synChipRef} className="inline-flex min-w-0">
        <Chip
          onClick={() => toggle("synopsis")}
          expanded={openPopover === "synopsis"}
          title={t("editor.synopsis.title")}
          outlined
        >
          <span className="shrink-0 font-bold text-primary">
            {t("editor.sceneDetail.synopsisChip")}
          </span>
          <span
            className={cn(
              "min-w-0 truncate italic",
              synopsis ? "text-muted-foreground" : "text-muted-foreground/60",
            )}
          >
            {synopsis || t("editor.sceneDetail.synopsisEmpty")}
          </span>
        </Chip>
      </span>

      <Chip onClick={openPanel} title={t("editor.toolbar.sceneMetaPanel")}>
        <span className="text-muted-foreground">
          {t("editor.sceneDetail.beatsChip", { count: beatCount })}
        </span>
      </Chip>

      <CodexRefPickerPopover
        open={openPopover === "pov"}
        onClose={() => setOpenPopover(null)}
        triggerRef={povChipRef}
        ariaLabel={t("editor.sceneDetail.pov")}
        searchPlaceholder={t("editor.sceneDetail.searchCharacter")}
        entries={characters}
        value={node.povCharacterId ?? null}
        onSelect={(id) =>
          void useTreeStore.getState().updatePovCharacter(sceneId, id)
        }
        dotColor={CHARACTER_DOT_COLOR}
      />
      <CodexRefPickerPopover
        open={openPopover === "location"}
        onClose={() => setOpenPopover(null)}
        triggerRef={locChipRef}
        ariaLabel={t("editor.sceneDetail.location")}
        searchPlaceholder={t("editor.sceneDetail.searchLocation")}
        entries={locations}
        value={node.locationId ?? null}
        onSelect={(id) =>
          void useTreeStore.getState().updateLocation(sceneId, id)
        }
        dotColor={LOCATION_DOT_COLOR}
      />
      <SceneDatePopover
        open={openPopover === "date"}
        onClose={() => setOpenPopover(null)}
        triggerRef={dateChipRef}
        node={node}
      />
      <SynopsisChipPopover
        open={openPopover === "synopsis"}
        onClose={() => setOpenPopover(null)}
        triggerRef={synChipRef}
        sceneId={sceneId}
      />
    </div>
  );
}
