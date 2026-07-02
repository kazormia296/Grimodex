import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Sparkles,
  CalendarCog,
  Link,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Tags,
  GitBranch,
  Lock,
  LockOpen,
  List,
  PanelRight,
  Rows3,
  Info,
} from "lucide-react";
import type { LaneDensity } from "./chronicleLayout";
import type { ChronicleCalendar } from "./chronicleTime";
import { ChronicleCalendarPopover } from "./ChronicleCalendarPopover";

export interface ChronicleToolbarProps {
  issueCount: number;
  showLegend: boolean;
  showEventList: boolean;
  showInspector: boolean;
  showEdges: boolean;
  density: LaneDensity;
  labelsOn: boolean;
  locked: boolean;
  calendar: ChronicleCalendar | null;
  creating: boolean;
  onNew: () => void;
  onExtract: () => void;
  onSaveCalendar: (cal: ChronicleCalendar) => void;
  onToggleLock: () => void;
  onGotoConflict: () => void;
  onToggleEdges: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleLegend: () => void;
  onToggleEventList: () => void;
  onToggleInspector: () => void;
  onSetDensity: (d: LaneDensity) => void;
  onToggleLabels: () => void;
}

// 他パネル準拠の枠なし意匠。アクション=ghost、トグル=active で bg-accent+text-primary。
const ghost =
  "inline-flex h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";
const toggleCls = (active: boolean) =>
  `inline-flex h-8 items-center gap-1 rounded px-2 text-xs ${
    active
      ? "bg-accent text-primary"
      : "text-muted-foreground hover:bg-accent hover:text-foreground"
  }`;
const iconBtn =
  "grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";

// narrow（＝ツールバー幅が狭い）ときにラベルを畳んでアイコンのみにする。ツールバー行を
// `@container` にして、各ボタンのラベル span にこのクラスを付ける。閾値はコンテナ幅基準
// （px は目安、調整可）。Tailwind v4 のコンテナクエリ（追加プラグイン不要）。
const collapseLabel = "@max-[800px]:hidden";

const DENSITIES: LaneDensity[] = ["compact", "standard", "roomy"];

/** ツールバー（左: 新規/抽出/暦/タイ線/ロック・右: 整合警告/因果/密度/ラベル/ズーム/凡例）＋凡例。 */
export function ChronicleToolbar(props: ChronicleToolbarProps) {
  const { t } = useTranslation();
  const calBtnRef = useRef<HTMLButtonElement>(null);
  const [calOpen, setCalOpen] = useState(false);
  const nextDensity = () =>
    props.onSetDensity(
      DENSITIES[(DENSITIES.indexOf(props.density) + 1) % DENSITIES.length],
    );
  const hasCalendar =
    !!props.calendar && props.calendar.seasonBoundaries.length > 0;

  return (
    <>
      <div className="@container flex h-12 flex-none items-center gap-1 border-b border-border bg-card px-3">
        <button
          type="button"
          data-testid="toolbar-new"
          onClick={props.onNew}
          disabled={props.creating}
          title={t("chronicle.newEvent", "新しいイベント")}
          className="inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-medium disabled:opacity-50"
          style={{
            background: "var(--primary)",
            color: "var(--primary-foreground)",
          }}
        >
          <Plus className="size-3.5" />
          <span className={collapseLabel}>
            {t("chronicle.newEvent", "新しいイベント")}
          </span>
        </button>
        <button
          type="button"
          onClick={props.onExtract}
          className={ghost}
          title={t("chronicle.aiExtract", "AI 抽出")}
        >
          <Sparkles className="size-3.5" />
          <span className={collapseLabel}>
            {t("chronicle.aiExtract", "AI 抽出")}
          </span>
        </button>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          ref={calBtnRef}
          onClick={() => setCalOpen((o) => !o)}
          className={toggleCls(calOpen)}
          title={
            hasCalendar
              ? t("chronicle.calendarEditor", "暦の設定")
              : t("chronicle.setupCalendar", "暦を設定")
          }
        >
          <CalendarCog className="size-3.5" />
          <span className={collapseLabel}>
            {hasCalendar
              ? t("chronicle.calendarEditor", "暦の設定")
              : t("chronicle.setupCalendar", "暦を設定")}
          </span>
        </button>
        <ChronicleCalendarPopover
          triggerRef={calBtnRef}
          open={calOpen}
          initial={props.calendar}
          onSave={props.onSaveCalendar}
          onClose={() => setCalOpen(false)}
        />
        <button
          type="button"
          onClick={props.onToggleLock}
          className={toggleCls(props.locked)}
          title={t(
            "chronicle.lockHint",
            "編集ロック（グラフ上のドラッグ移動・端の伸縮・D&D因果エッジ・空白作成を無効化。インスペクタ編集は可）",
          )}
        >
          {props.locked ? (
            <Lock className="size-3.5" />
          ) : (
            <LockOpen className="size-3.5" />
          )}
          <span className={collapseLabel}>
            {props.locked
              ? t("chronicle.locked", "ロック中")
              : t("chronicle.lock", "ロック")}
          </span>
        </button>

        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            onClick={props.onToggleEventList}
            className={toggleCls(props.showEventList)}
            title={t("chronicle.eventList", "イベント一覧")}
          >
            <List className="size-3.5" />
            <span className={collapseLabel}>
              {t("chronicle.eventListShort", "一覧")}
            </span>
          </button>
          <button
            type="button"
            onClick={props.onToggleInspector}
            className={toggleCls(props.showInspector)}
            title={t("chronicle.inspector", "詳細パネル")}
          >
            <PanelRight className="size-3.5" />
            <span className={collapseLabel}>
              {t("chronicle.inspectorShort", "詳細")}
            </span>
          </button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          {props.issueCount > 0 && (
            <button
              type="button"
              onClick={props.onGotoConflict}
              title={`${t("chronicle.issues", "整合警告")} ${props.issueCount}`}
              className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs"
              style={{
                background: "color-mix(in oklch, #e0a23a 14%, transparent)",
                color: "color-mix(in oklch, #e0a23a 78%, var(--foreground))",
              }}
            >
              <AlertTriangle className="size-3.5" />
              <span className={collapseLabel}>
                {t("chronicle.issues", "整合警告")} {props.issueCount}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={props.onToggleEdges}
            className={toggleCls(props.showEdges)}
            title={t("chronicle.causalEdges", "因果エッジ")}
          >
            <GitBranch className="size-3.5" />
            <span className={collapseLabel}>
              {t("chronicle.causal", "因果")}
            </span>
          </button>
          <button
            type="button"
            data-testid="toolbar-density"
            onClick={nextDensity}
            className={ghost}
            title={`${t("chronicle.densityLabel", "レーン密度")}: ${t(
              `chronicle.density.${props.density}`,
              props.density,
            )}`}
          >
            <Rows3 className="size-3.5" />
            <span className={collapseLabel}>
              {t(`chronicle.density.${props.density}`, props.density)}
            </span>
          </button>
          <button
            type="button"
            onClick={props.onToggleLabels}
            className={toggleCls(props.labelsOn)}
            title={t("chronicle.markerLabels", "ラベル表示")}
          >
            <Tags className="size-3.5" />
            <span className={collapseLabel}>
              {t("chronicle.labels", "ラベル")}
            </span>
          </button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <button
            type="button"
            onClick={props.onZoomOut}
            className={iconBtn}
            aria-label={t("chronicle.zoomOut", "縮小")}
          >
            <ZoomOut className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={props.onZoomIn}
            className={iconBtn}
            aria-label={t("chronicle.zoomIn", "拡大")}
          >
            <ZoomIn className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={props.onFit}
            className={ghost}
            title={t("chronicle.fit", "全体を表示")}
          >
            <Maximize2 className="size-3.5" />
            <span className={collapseLabel}>
              {t("chronicle.fitShort", "全体")}
            </span>
          </button>
          <button
            type="button"
            data-testid="toolbar-legend"
            onClick={props.onToggleLegend}
            className={toggleCls(props.showLegend)}
            title={t("chronicle.legend", "凡例")}
          >
            <Info className="size-3.5" />
            <span className={collapseLabel}>
              {t("chronicle.legend", "凡例")}
            </span>
          </button>
        </div>
      </div>

      {props.showLegend && <ChronicleLegend />}
    </>
  );
}

function ChronicleLegend() {
  const { t } = useTranslation();
  const item = (swatch: React.ReactNode, label: string, title?: string) => (
    <span className="flex items-center gap-1.5" title={title}>
      {swatch}
      {label}
    </span>
  );
  // 出来事の外周線サンプル（確度）。確定=実線 / おおよそ=実線+減光 / 不明=破線。
  const confSwatch = (style: "solid" | "dashed", faded = false) => (
    <span
      className="rounded-sm"
      style={{
        width: 16,
        height: 10,
        background: "var(--card)",
        border: "1px solid var(--muted-foreground)",
        borderStyle: style,
        opacity: faded ? 0.55 : 1,
      }}
    />
  );
  return (
    <div className="flex h-[34px] flex-none flex-wrap items-center gap-3.5 border-b border-border bg-muted/30 px-4 text-[11px] text-muted-foreground">
      {item(
        <span className="size-[9px] rounded-full bg-muted-foreground" />,
        t("chronicle.legendEvent", "イベント"),
      )}
      {item(
        <span
          style={{
            width: 0,
            height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderBottom: "9px solid oklch(0.6 0.14 150)",
          }}
        />,
        t("chronicle.kind.birth", "出生"),
      )}
      {item(
        <span
          style={{
            width: 8,
            height: 8,
            background: "oklch(0.5 0.07 25)",
            transform: "rotate(45deg)",
          }}
        />,
        t("chronicle.kind.death", "死亡"),
      )}
      {item(
        <span
          style={{
            width: 18,
            height: 9,
            borderRadius: 3.5,
            background: "color-mix(in oklch, var(--primary) 22%, transparent)",
            border:
              "1px solid color-mix(in oklch, var(--primary) 40%, transparent)",
          }}
        />,
        t("chronicle.legendInterval", "期間"),
      )}
      {item(
        <Link className="size-3 opacity-60" />,
        t("chronicle.legendOnpage", "シーンに登場"),
        t(
          "chronicle.legendOnpageHint",
          "シーンに紐づく（オンページ）。無印はオフページ（背景）。",
        ),
      )}
      <span className="mx-0.5 h-3.5 w-px bg-border" />
      {item(
        confSwatch("solid"),
        t("chronicle.precision.exact", "確定"),
        t("chronicle.exactHint", "日付が確定している"),
      )}
      {item(
        confSwatch("solid", true),
        t("chronicle.precision.approx", "おおよそ"),
        t("chronicle.approxHint", "順序は確実だが日付は概算"),
      )}
      {item(
        confSwatch("dashed"),
        t("chronicle.precision.unknown", "不明"),
        t("chronicle.unknownHint", "日付の時点そのものが不確実"),
      )}
      <span className="mx-0.5 h-3.5 w-px bg-border" />
      {item(
        <span
          className="grid place-items-center rounded-full text-[9px] font-bold text-white"
          style={{ width: 14, height: 14, background: "#e0a23a" }}
        >
          !
        </span>,
        t("chronicle.legendConflict", "整合警告"),
      )}
      {item(
        <span
          style={{
            width: 20,
            height: 0,
            borderTop: "1.5px solid var(--muted-foreground)",
          }}
        />,
        t("chronicle.legendCausal", "因果"),
      )}
      {item(
        <span
          style={{ width: 20, height: 0, borderTop: "2px solid #d6463f" }}
        />,
        t("chronicle.legendCausalConflict", "因果の矛盾"),
      )}
      <span className="ms-auto text-muted-foreground/70">
        {t("chronicle.legendHint", "ドラッグで移動・ホイールで拡大縮小")}
      </span>
    </div>
  );
}
