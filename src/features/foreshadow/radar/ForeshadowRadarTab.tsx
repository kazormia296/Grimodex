import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForeshadowStore } from "../foreshadowStore";
import { useForeshadowNavStore } from "../foreshadowNavStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { requestForeshadowJump } from "../foreshadowSceneJump";
import { buildSetupScenesByForeshadowId } from "../api";
import {
  FORESHADOW_LABEL_DOT_BG,
  FORESHADOW_LABEL_FILL_CLASS,
  FORESHADOW_LABEL_PILL_CLASS,
  FORESHADOW_LABEL_STROKE_CLASS,
} from "../foreshadowLabelStyles";
import type { DerivedLabel } from "../types";
import {
  buildForeshadowRadarModel,
  type RadarArc,
} from "./foreshadowRadarModel";

// SVG viewBox 座標 (TensionCurve と同じく preserveAspectRatio="none" で横に伸ばす)。
const W = 100;
const H = 60;
const PAD_X = 2;
const BASELINE_Y = 52;
const TOP_Y = 6;
const MAX_ARC_H = BASELINE_Y - TOP_Y;

function xFor(index: number, maxIndex: number): number {
  if (maxIndex <= 0) return W / 2;
  return PAD_X + (index / maxIndex) * (W - 2 * PAD_X);
}

function xFrac(index: number, maxIndex: number): number {
  return xFor(index, maxIndex) / W;
}

function hForSpan(span: number, maxIndex: number): number {
  if (maxIndex <= 0) return MAX_ARC_H * 0.4;
  const ratio = Math.min(1, span / maxIndex);
  return 8 + ratio * (MAX_ARC_H - 8);
}

export function ForeshadowRadarTab() {
  const { t } = useTranslation();
  const items = useForeshadowStore((s) => s.items);
  const setupScenes = useForeshadowStore((s) => s.setupScenesByForeshadowId);
  const setupsByForeshadowId = useForeshadowStore(
    (s) => s.setupsByForeshadowId,
  );
  const nodes = useTreeStore((s) => s.nodes);
  const [hidePaid, setHidePaid] = useState(false);

  // load 時スナップショット (setupScenes) を基本に、setup 変更で再ロード済みの
  // 伏線は live な setupsByForeshadowId で上書きし、編集後も俯瞰を正確に保つ。
  const effectiveSetupScenes = useMemo(() => {
    const merged: Record<string, string[]> = { ...(setupScenes ?? {}) };
    for (const fid of Object.keys(setupsByForeshadowId ?? {})) {
      const rows = setupsByForeshadowId[fid] ?? [];
      merged[fid] = buildSetupScenesByForeshadowId(rows)[fid] ?? [];
    }
    return merged;
  }, [setupScenes, setupsByForeshadowId]);

  const model = useMemo(() => {
    const order = computeGlobalSceneOrder(nodes);
    return buildForeshadowRadarModel(items, effectiveSetupScenes, order, nodes);
  }, [items, effectiveSetupScenes, nodes]);

  const { summary, arcs, floating, bands, maxIndex } = model;
  const visibleArcs = hidePaid ? arcs.filter((a) => a.label !== "paid") : arcs;
  const hasPaid = arcs.some((a) => a.label === "paid");

  if (items.length === 0) {
    return (
      <div className="p-6 text-center text-[11px] text-muted-foreground">
        {t("foreshadow.panel.empty", "伏線はありません")}
      </div>
    );
  }

  const usedLabels = new Set<DerivedLabel>([
    ...arcs.map((a) => a.label),
    ...floating.map((f) => f.label),
  ]);

  const pct = (n: number) =>
    summary.total > 0 ? (n / summary.total) * 100 : 0;

  function arcTooltip(a: RadarArc): string {
    const parts = [a.title, t(`foreshadow.label.${a.label}`)];
    if (a.open) parts.push(t("foreshadow.radar.tooltipOpen", "未回収"));
    else if (a.broken)
      parts.push(
        t("foreshadow.radar.tooltipBroken", "回収先シーンが見つかりません"),
      );
    if (a.startIndex === null && a.endIndex !== null)
      parts.push(t("foreshadow.radar.tooltipOrphan", "Setup なし"));
    if (a.startIndex !== null)
      parts.push(
        t("foreshadow.radar.tooltipDistance", {
          n: a.span,
          defaultValue: "距離 {{n}}",
        }),
      );
    return parts.join(" · ");
  }

  function onArcClick(a: RadarArc) {
    const payoffFrom = a.payoffFromPos ?? undefined;
    const payoffTo = a.payoffToPos ?? undefined;
    if (a.open) {
      if (a.startSceneId) requestForeshadowJump(a.startSceneId);
      else if (a.endSceneId)
        requestForeshadowJump(a.endSceneId, payoffFrom, payoffTo);
    } else {
      if (a.endSceneId)
        requestForeshadowJump(a.endSceneId, payoffFrom, payoffTo);
      else if (a.startSceneId) requestForeshadowJump(a.startSceneId);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Summary header */}
      <div className="border-b border-border px-2 py-2">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] font-medium text-muted-foreground">
            {t("foreshadow.radar.recoveryRate", "回収率")}
          </span>
          <span className="text-sm font-semibold tabular-nums">
            {Math.round(summary.recoveryRate * 100)}%
          </span>
        </div>
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          data-testid="foreshadow-radar-recovery-bar"
        >
          <div
            className="bg-green-500"
            style={{ width: `${pct(summary.paid)}%` }}
          />
          <div
            className="bg-blue-500"
            style={{ width: `${pct(summary.open)}%` }}
          />
          <div
            className="bg-amber-500"
            style={{ width: `${pct(summary.atRisk)}%` }}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          <StatChip
            color="bg-green-500"
            label={t("foreshadow.radar.statPaid", "確定回収")}
            count={summary.paid}
          />
          <StatChip
            color="bg-blue-500"
            label={t("foreshadow.radar.statOpen", "未回収")}
            count={summary.open}
          />
          <StatChip
            color="bg-amber-500"
            label={t("foreshadow.radar.statAtRisk", "要注意")}
            count={summary.atRisk}
          />
          {summary.abandoned > 0 && (
            <StatChip
              color="bg-muted-foreground/30"
              label={t("foreshadow.radar.statAbandoned", "破棄")}
              count={summary.abandoned}
            />
          )}
        </div>
      </div>

      {/* Hide-paid toggle */}
      {hasPaid && (
        <div className="flex items-center justify-end border-b border-border px-2 py-1">
          <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              data-testid="foreshadow-radar-hide-paid"
              checked={hidePaid}
              onChange={(e) => setHidePaid(e.target.checked)}
              className="h-3 w-3 accent-foreground"
            />
            {t("foreshadow.radar.hidePaid", "回収済みを隠す")}
          </label>
        </div>
      )}

      {/* Arc timeline */}
      <div className="px-2 py-2">
        {visibleArcs.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground">
            {t("foreshadow.radar.empty", "表示できる伏線がありません")}
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="h-44 w-full"
              role="img"
              aria-label={t("foreshadow.radar.ariaChart", "伏線回収レーダー")}
              data-testid="foreshadow-radar-chart"
            >
              {/* chapter band dividers */}
              {bands.map((b, i) =>
                i > 0 ? (
                  <line
                    key={`band-${b.key}-${i}`}
                    x1={
                      (xFor(bands[i - 1].endIndex, maxIndex) +
                        xFor(b.startIndex, maxIndex)) /
                      2
                    }
                    x2={
                      (xFor(bands[i - 1].endIndex, maxIndex) +
                        xFor(b.startIndex, maxIndex)) /
                      2
                    }
                    y1={TOP_Y}
                    y2={BASELINE_Y}
                    className="stroke-border"
                    strokeWidth={0.3}
                    strokeDasharray="1 1"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
              {/* baseline */}
              <line
                x1={PAD_X}
                x2={W - PAD_X}
                y1={BASELINE_Y}
                y2={BASELINE_Y}
                className="stroke-border"
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
              />
              {visibleArcs.map((a) => (
                <ArcShape
                  key={a.foreshadowId}
                  arc={a}
                  maxIndex={maxIndex}
                  title={arcTooltip(a)}
                  onClick={() => onArcClick(a)}
                />
              ))}
            </svg>

            {/* chapter labels */}
            <div className="relative mt-1 h-3.5">
              {bands.map((b, i) => (
                <span
                  key={`lbl-${b.key}-${i}`}
                  className="absolute -translate-x-1/2 truncate text-[9px] text-muted-foreground"
                  style={{
                    left: `${((xFrac(b.startIndex, maxIndex) + xFrac(b.endIndex, maxIndex)) / 2) * 100}%`,
                    maxWidth: "32%",
                  }}
                  title={b.label ?? undefined}
                >
                  {b.label ?? "—"}
                </span>
              ))}
            </div>
          </>
        )}

        {/* legend */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/70" />
            {t("foreshadow.radar.legendSetup", "設置")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full ring-1 ring-foreground/70" />
            {t("foreshadow.radar.legendOpen", "未回収")}
          </span>
          {[...usedLabels]
            .filter((l) => l !== "abandoned")
            .map((label) => (
              <span key={label} className="inline-flex items-center gap-1">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${FORESHADOW_LABEL_DOT_BG[label]}`}
                />
                {t(`foreshadow.label.${label}`)}
              </span>
            ))}
        </div>
      </div>

      {/* Unplaced foreshadows */}
      {floating.length > 0 && (
        <div className="border-t border-border px-2 py-2">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground">
            {t("foreshadow.radar.floatingTitle", {
              count: floating.length,
              defaultValue: "未配置の伏線 ({{count}})",
            })}
          </div>
          <div className="flex flex-wrap gap-1">
            {floating.map((f) => (
              <button
                key={f.foreshadowId}
                type="button"
                data-testid={`foreshadow-radar-floating-${f.foreshadowId}`}
                onClick={() =>
                  useForeshadowNavStore
                    .getState()
                    .requestPanelHighlight(f.foreshadowId)
                }
                className={`max-w-[12rem] truncate rounded px-1.5 py-0.5 text-[10px] font-medium ${FORESHADOW_LABEL_PILL_CLASS[f.label]}`}
                title={f.title}
              >
                {f.title || t("foreshadow.radar.untitled", "(無題)")}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[9px] text-muted-foreground/70">
            {t(
              "foreshadow.radar.floatingHelp",
              "Setup も Payoff も本文に未配置",
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatChip({
  color,
  label,
  count,
}: {
  color: string;
  label: string;
  count: number;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-foreground">
        {count}
      </span>
    </span>
  );
}

function ArcShape({
  arc,
  maxIndex,
  title,
  onClick,
}: {
  arc: RadarArc;
  maxIndex: number;
  title: string;
  onClick: () => void;
}) {
  const stroke = FORESHADOW_LABEL_STROKE_CLASS[arc.label];
  const fill = FORESHADOW_LABEL_FILL_CLASS[arc.label];

  // 端点座標。
  const hasStart = arc.startIndex !== null;
  const hasEnd = arc.endIndex !== null;
  const x0 = hasStart ? xFor(arc.startIndex as number, maxIndex) : null;
  // open/broken は末尾フロンティアまでダングリング。
  const x1 = hasEnd
    ? xFor(arc.endIndex as number, maxIndex)
    : xFor(maxIndex, maxIndex);
  const dangling = !hasEnd; // open または broken
  const h = hForSpan(arc.span, maxIndex);

  // orphan_payoff: setup 不在・payoff のみ → マーカーだけ。
  const arcStartX = hasStart ? (x0 as number) : x1;
  const drawArc = hasStart; // setup があるときのみ弧を描く
  const midX = (arcStartX + x1) / 2;
  const path = `M ${arcStartX} ${BASELINE_Y} Q ${midX} ${BASELINE_Y - h} ${x1} ${BASELINE_Y}`;

  return (
    <g
      className="cursor-pointer opacity-80 hover:opacity-100"
      onClick={onClick}
      data-testid={`foreshadow-radar-arc-${arc.foreshadowId}`}
    >
      <title>{title}</title>
      {/* 広いヒット領域 (透明) */}
      {drawArc && (
        <path
          d={path}
          className="fill-none stroke-transparent"
          strokeWidth={6}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {drawArc && (
        <path
          d={path}
          className={`fill-none ${stroke}`}
          strokeWidth={1.4}
          strokeDasharray={dangling ? "2 1.5" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* setup マーカー (塗り) */}
      {hasStart && (
        <circle
          cx={x0 as number}
          cy={BASELINE_Y}
          r={1.3}
          className={fill}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* payoff / dangling 端マーカー */}
      {hasEnd ? (
        <circle
          cx={x1}
          cy={BASELINE_Y}
          r={1.5}
          className={fill}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <circle
          cx={x1}
          cy={BASELINE_Y}
          r={1.4}
          className={`fill-background ${stroke}`}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}
