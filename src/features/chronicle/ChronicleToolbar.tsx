import { useTranslation } from "react-i18next";
import {
  Plus,
  Sparkles,
  CalendarCog,
  Spline,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Tags,
  GitBranch,
} from "lucide-react";
import type { LaneDensity } from "./chronicleLayout";

export interface ChronicleToolbarProps {
  issueCount: number;
  showLegend: boolean;
  showEdges: boolean;
  tieMode: boolean;
  density: LaneDensity;
  labelsOn: boolean;
  hasCalendar: boolean;
  creating: boolean;
  onNew: () => void;
  onExtract: () => void;
  onCalendar: () => void;
  onToggleTie: () => void;
  onGotoConflict: () => void;
  onToggleEdges: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleLegend: () => void;
  onSetDensity: (d: LaneDensity) => void;
  onToggleLabels: () => void;
}

const ghost =
  "inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent";
const toggleCls = (active: boolean) =>
  `inline-flex h-[30px] items-center gap-1 rounded-lg px-2.5 text-xs ${
    active
      ? "border text-primary"
      : "border border-border bg-card text-muted-foreground hover:bg-accent"
  }`;
const toggleStyle = (active: boolean) =>
  active
    ? {
        borderColor: "color-mix(in oklch, var(--primary) 45%, transparent)",
        background: "color-mix(in oklch, var(--primary) 9%, transparent)",
      }
    : undefined;

const DENSITIES: LaneDensity[] = ["compact", "standard", "roomy"];

/** ツールバー（左: 新規/抽出/暦/タイ線・右: 整合警告/因果/密度/ラベル/ズーム/凡例）＋凡例ストリップ。 */
export function ChronicleToolbar(props: ChronicleToolbarProps) {
  const { t } = useTranslation();
  const nextDensity = () =>
    props.onSetDensity(
      DENSITIES[(DENSITIES.indexOf(props.density) + 1) % DENSITIES.length],
    );

  return (
    <>
      <div className="flex h-12 flex-none items-center gap-1.5 border-b border-border bg-card px-3">
        <button
          type="button"
          onClick={props.onNew}
          disabled={props.creating}
          className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs font-medium disabled:opacity-50"
          style={{
            background: "var(--primary)",
            color: "var(--primary-foreground)",
          }}
        >
          <Plus className="size-3.5" />{" "}
          {t("chronicle.newEvent", "新しい出来事")}
        </button>
        <button type="button" onClick={props.onExtract} className={ghost}>
          <Sparkles className="size-3.5" />{" "}
          {t("chronicle.aiExtract", "AI 抽出")}
        </button>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button type="button" onClick={props.onCalendar} className={ghost}>
          <CalendarCog className="size-3.5" />
          {props.hasCalendar
            ? t("chronicle.calendarEditor", "暦の設定")
            : t("chronicle.setupCalendar", "暦を設定")}
        </button>
        <button
          type="button"
          onClick={props.onToggleTie}
          className={toggleCls(props.tieMode)}
          style={toggleStyle(props.tieMode)}
          title={t("chronicle.tieView", "読む順×作中時間")}
        >
          <Spline className="size-3.5" /> {t("chronicle.tie", "タイ線")}
        </button>

        <div className="ms-auto flex items-center gap-1.5">
          {props.issueCount > 0 && (
            <button
              type="button"
              onClick={props.onGotoConflict}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border px-2.5 text-xs"
              style={{
                borderColor: "color-mix(in oklch, #e0a23a 50%, transparent)",
                background: "color-mix(in oklch, #e0a23a 14%, transparent)",
                color: "color-mix(in oklch, #e0a23a 75%, var(--foreground))",
              }}
            >
              <AlertTriangle className="size-3.5" />
              {t("chronicle.issues", "整合警告")} {props.issueCount}
            </button>
          )}
          <button
            type="button"
            onClick={props.onToggleEdges}
            className={toggleCls(props.showEdges)}
            style={toggleStyle(props.showEdges)}
            title={t("chronicle.causalEdges", "因果エッジ")}
          >
            <GitBranch className="size-3.5" /> {t("chronicle.causal", "因果")}
          </button>
          <button
            type="button"
            onClick={nextDensity}
            className={ghost}
            title={t("chronicle.densityLabel", "レーン密度")}
          >
            {t(`chronicle.density.${props.density}`, props.density)}
          </button>
          <button
            type="button"
            onClick={props.onToggleLabels}
            className={toggleCls(props.labelsOn)}
            style={toggleStyle(props.labelsOn)}
            title={t("chronicle.markerLabels", "ラベル表示")}
          >
            <Tags className="size-3.5" />
          </button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <button
            type="button"
            onClick={props.onZoomOut}
            className="grid size-7 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:bg-accent"
            aria-label={t("chronicle.zoomOut", "縮小")}
          >
            <ZoomOut className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={props.onZoomIn}
            className="grid size-7 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:bg-accent"
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
            <Maximize2 className="size-3.5" /> {t("chronicle.fitShort", "全体")}
          </button>
          <button
            type="button"
            onClick={props.onToggleLegend}
            className={toggleCls(props.showLegend)}
            style={toggleStyle(props.showLegend)}
          >
            {t("chronicle.legend", "凡例")}
          </button>
        </div>
      </div>

      {props.showLegend && <ChronicleLegend />}
    </>
  );
}

function ChronicleLegend() {
  const { t } = useTranslation();
  const item = (swatch: React.ReactNode, label: string) => (
    <span className="flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  );
  return (
    <div className="flex h-[34px] flex-none flex-wrap items-center gap-4 border-b border-border bg-muted/30 px-4 text-[11px] text-muted-foreground">
      {item(
        <span className="size-[9px] rounded-full bg-muted-foreground" />,
        t("chronicle.legendEvent", "出来事"),
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
          className="rounded-sm"
          style={{
            width: 18,
            height: 9,
            background: "color-mix(in oklch, var(--primary) 22%, transparent)",
            border:
              "1px solid color-mix(in oklch, var(--primary) 40%, transparent)",
          }}
        />,
        t("chronicle.legendInterval", "期間"),
      )}
      {item(
        <span
          className="rounded-full border-2"
          style={{
            width: 10,
            height: 10,
            borderColor: "var(--muted-foreground)",
            background: "var(--card)",
          }}
        />,
        t("chronicle.legendOffpage", "背景（オフページ）"),
      )}
      {item(
        <span
          style={{
            width: 18,
            height: 0,
            borderTop: "1.5px dashed var(--muted-foreground)",
          }}
        />,
        t("chronicle.legendUncertain", "不確定"),
      )}
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
