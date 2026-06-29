import type { EventKind, EventPrecision } from "@/db/schema";
import {
  dayToX,
  scrollGeom,
  type ScrollGeom,
  type View,
} from "./chronicleAxis";
import {
  packLanes,
  type LanePackResult,
  type PackLaneInput,
} from "./chronicleLanePack";
import { adaptiveTicks, type RulerTicks } from "./chronicleTicks";
import {
  buildCausalBezier,
  type BezierEdge,
  type CausalRel,
} from "./chronicleCausalBezier";
import type { ChronicleCalendar, DateLang } from "./chronicleTime";

/**
 * 作中年表ビューポートのレイアウトを純関数で組み上げるオーケストレータ。
 * 5 つの幾何モジュール（axis/ticks/lanepack/causal-bezier）を一つの
 * ChronicleLayout に束ね、React 側は描画に専念できるようにする。
 * 決定性: 乱数/時刻/IO なし（dayToX 等は与えた view から純粋に算出）。
 */

export type LaneDensity = "compact" | "standard" | "roomy";

/**
 * マルチレーン（複数 Codex 所属）対応: 1 出来事を所属レーンごとに描くため、
 * 参加レーンの複製マーカーは合成 id `${eventId}::${codexId}` をキーにする。
 * 本物の eventId（選択/ドラッグ/因果エッジ用）は realEventId で復元する。
 */
export const LANE_DUP_SEP = "::";
export function laneDupId(eventId: string, codexId: string): string {
  return `${eventId}${LANE_DUP_SEP}${codexId}`;
}
export function realEventId(id: string): string {
  const i = id.indexOf(LANE_DUP_SEP);
  return i === -1 ? id : id.slice(0, i);
}

export interface DensitySpacing {
  /** 左レーンガター幅(px)。 */
  gutterX: number;
  /** レーン上下パディング(px)。 */
  laneVPad: number;
  /** マーカー高(px)。 */
  tokenH: number;
  /** レーン内の行間(px)。 */
  rowGap: number;
  /** point マーカーの最大幅(px)。 */
  maxTok: number;
}

const SPACING: Record<LaneDensity, DensitySpacing> = {
  compact: { gutterX: 178, laneVPad: 9, tokenH: 23, rowGap: 6, maxTok: 196 },
  standard: { gutterX: 190, laneVPad: 13, tokenH: 26, rowGap: 9, maxTok: 218 },
  roomy: { gutterX: 206, laneVPad: 16, tokenH: 30, rowGap: 11, maxTok: 248 },
};

export function densitySpacing(d: LaneDensity): DensitySpacing {
  return SPACING[d] ?? SPACING.standard;
}

/** マーカーの推定幅(px)。行詰めの衝突判定（lanePack）に使う。 */
export function estMarkerWidth(args: {
  title: string;
  kind: EventKind;
  secret: boolean;
  isInterval: boolean;
  barWidth: number;
  labelsOn: boolean;
}): number {
  const { title, kind, secret, isInterval, barWidth, labelsOn } = args;
  if (!labelsOn) return isInterval ? Math.max(barWidth, 30) : 26;
  const t = title.length;
  if (isInterval) {
    const lab = 24 + Math.min(t * 13, 150) + (secret ? 32 : 0);
    return Math.max(barWidth, lab, 52);
  }
  const kindExtra = kind === "birth" || kind === "death" ? 40 : 0;
  return 17 + 6 + Math.min(t * 13, 150) + kindExtra + (secret ? 34 : 0) + 14;
}

export interface LayoutEventInput {
  id: string;
  title: string;
  primaryCodexId: string | null;
  kind: EventKind;
  precision: EventPrecision;
  secret: boolean;
  sceneLinked: boolean;
  /** effectiveDays 由来の開始日番号。 */
  startDay: number;
  /** effectiveDays 由来の終了日番号（point は null）。 */
  endDay: number | null;
}

export interface LayoutLane {
  codexId: string | null;
  name: string;
  /** codex の種別（character/location/…）or "unassigned"。 */
  kind: string;
  unassigned: boolean;
  /** このレーンに属する eventId（描画順は startX でソートされる）。 */
  eventIds: string[];
}

/** マーカー 1 個の確定描画情報（left は lanePack 由来＝point は startX-9）。 */
export interface MarkerRender {
  left: number;
  top: number;
  isInterval: boolean;
  barWidth: number | null;
}

export interface ChronicleLayout {
  spacing: DensitySpacing;
  pack: LanePackResult;
  ticks: RulerTicks;
  edges: BezierEdge[];
  scroll: ScrollGeom;
  contentHeight: number;
  /** 縦グリッド線の x（minor=細・major=粗）。 */
  minorGridX: number[];
  majorGridX: number[];
  /** eventId → 確定描画情報。 */
  markerById: Map<string, MarkerRender>;
}

export interface BuildLayoutArgs {
  events: LayoutEventInput[];
  lanes: LayoutLane[];
  view: View;
  trackW: number;
  density: LaneDensity;
  labelsOn: boolean;
  calendar: ChronicleCalendar;
  hasCalendarAxis: boolean;
  dataStart: number;
  dataEnd: number;
  relations: CausalRel[];
  /** 因果矛盾ペア（`${cause}|${effect}`）。赤エッジ判定に使う。 */
  causalConflictPairs: Set<string>;
  lang?: DateLang;
}

export function buildChronicleLayout(args: BuildLayoutArgs): ChronicleLayout {
  const {
    events,
    lanes,
    view,
    trackW,
    density,
    labelsOn,
    calendar,
    hasCalendarAxis,
    dataStart,
    dataEnd,
    relations,
    causalConflictPairs,
    lang,
  } = args;

  const spacing = densitySpacing(density);
  const byId = new Map(events.map((e) => [e.id, e]));

  const packInput: PackLaneInput[] = lanes.map((lane) => ({
    codexId: lane.codexId,
    name: lane.name,
    kind: lane.kind,
    unassigned: lane.unassigned,
    events: lane.eventIds.flatMap((id) => {
      const e = byId.get(id);
      if (!e) return [];
      const startX = dayToX(view, e.startDay);
      const isInterval = e.endDay != null;
      const barWidth = isInterval
        ? Math.max((e.endDay! - e.startDay) * view.pxPerDay, 52)
        : null;
      const estWidth = estMarkerWidth({
        title: e.title,
        kind: e.kind,
        secret: e.secret,
        isInterval,
        barWidth: barWidth ?? 0,
        labelsOn,
      });
      return [{ id, startX, isInterval, barWidth, estWidth }];
    }),
  }));

  const pack = packLanes({ lanes: packInput, spacing });

  // pack.lanes/markers は startX 昇順なので、確定 left/top を marker から拾い、
  // barWidth/isInterval を packInput から引いて描画情報を一意にまとめる。
  const intervalById = new Map<
    string,
    { isInterval: boolean; barWidth: number | null }
  >();
  for (const lane of packInput) {
    for (const ev of lane.events) {
      intervalById.set(ev.id, {
        isInterval: ev.isInterval,
        barWidth: ev.barWidth,
      });
    }
  }
  const markerById = new Map<string, MarkerRender>();
  for (const lane of pack.lanes) {
    for (const m of lane.markers) {
      const meta = intervalById.get(m.eventId);
      markerById.set(m.eventId, {
        left: m.left,
        top: m.cy - spacing.tokenH / 2,
        isInterval: meta?.isInterval ?? false,
        barWidth: meta?.barWidth ?? null,
      });
    }
  }

  const ticks = adaptiveTicks({
    pxPerDay: view.pxPerDay,
    viewStartDay: view.viewStartDay,
    trackW,
    calendar,
    hasCalendarAxis,
    lang,
  });

  const edges = buildCausalBezier({
    relations,
    centers: pack.centers,
    conflictPairs: causalConflictPairs,
  });

  const scroll = scrollGeom({ view, trackW, dataStart, dataEnd });

  return {
    spacing,
    pack,
    ticks,
    edges,
    scroll,
    contentHeight: pack.totalHeight,
    minorGridX: ticks.minor.map((t) => t.x),
    majorGridX: ticks.major.map((t) => t.x).filter((x) => x >= 0),
    markerById,
  };
}

/** causalConflicts から `${cause}|${effect}` の集合を作る小ヘルパ。 */
export function causalConflictPairSet(
  conflicts: { causeId: string; effectId: string }[],
): Set<string> {
  return new Set(conflicts.map((c) => `${c.causeId}|${c.effectId}`));
}
