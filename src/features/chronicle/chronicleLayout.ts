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

/**
 * 未割当グループレーンを「割当先 codexId」文字列チャンネルに載せる接頭辞。
 * viewport/gutter は移動・作成先を 1 本の codexId 文字列で受け渡すので、
 * 未割当の別レーン（laneGroup）は `__group_<id>` で表し panel 側で解く。
 */
export const GROUP_PREFIX = "__group_";
export function groupLaneKey(groupId: string): string {
  return `${GROUP_PREFIX}${groupId}`;
}

/** レーンの一意キー（codex=codexId / 基底未割当=__unassigned / 追加群=__group_<g>）。 */
export function laneKeyOf(lane: {
  unassigned: boolean;
  codexId: string | null;
  groupId?: string;
}): string {
  return lane.unassigned
    ? lane.groupId
      ? groupLaneKey(lane.groupId)
      : "__unassigned"
    : (lane.codexId ?? "__unassigned");
}

/**
 * レーン→移動/作成先キー。実 codex は codexId、未割当の追加群は `__group_<g>`、
 * 基底未割当は null。viewport が D&D/作成の落下先レーンから求める。
 */
export function laneTargetKey(lane: {
  unassigned: boolean;
  codexId: string | null;
  groupId?: string;
}): string | null {
  if (lane.unassigned) return lane.groupId ? groupLaneKey(lane.groupId) : null;
  return lane.codexId;
}

/**
 * laneTargetKey の逆。割当先キーを primaryCodexId / laneGroup に解く。
 * - `__group_<g>` → laneGroup=g（未割当のまま別レーンへ）。
 * - 実 codexId    → primaryCodexId=codexId。
 * - null（基底未割当） → 両方 ""（backend が NULL クリア）。
 */
export function decodeLaneTarget(target: string | null): {
  primaryCodexId: string;
  laneGroup: string;
} {
  if (target == null) return { primaryCodexId: "", laneGroup: "" };
  if (target.startsWith(GROUP_PREFIX))
    return { primaryCodexId: "", laneGroup: target.slice(GROUP_PREFIX.length) };
  return { primaryCodexId: target, laneGroup: "" };
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
  const { title, secret, isInterval, barWidth, labelsOn } = args;
  if (!labelsOn) return isInterval ? Math.max(barWidth, 30) : 26;
  const t = title.length;
  if (isInterval) {
    const lab = 24 + Math.min(t * 13, 150) + (secret ? 32 : 0);
    return Math.max(barWidth, lab, 52);
  }
  // 種別は先頭グリフ（三角/菱形/丸＝ほぼ同幅）で示すため種別ごとの幅加算は無い。
  // 旧 kindExtra=40 は廃止済みの種別「文字」タグ用の死んだ予約だったため除去
  // （birth/death point の outX が可視ピル末尾より ~38px 右へ突き出していた）。
  return 17 + 6 + Math.min(t * 13, 150) + (secret ? 34 : 0) + 14;
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
  /** 出来事 0 でも残す空の未割当レーンか。 */
  keepEmpty?: boolean;
  /** 未割当グループ id。 */
  groupId?: string;
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
  /** world geometry の原点を現在 viewport へ射影する水平 offset。 */
  worldOffsetX: number;
}

export interface ChronicleWorldGeometry {
  spacing: DensitySpacing;
  pack: LanePackResult;
  edges: BezierEdge[];
  contentHeight: number;
  markerById: Map<string, MarkerRender>;
  originDay: number;
  pxPerDay: number;
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

export interface BuildWorldGeometryArgs {
  events: LayoutEventInput[];
  lanes: LayoutLane[];
  pxPerDay: number;
  originDay: number;
  density: LaneDensity;
  labelsOn: boolean;
  relations: CausalRel[];
  causalConflictPairs: Set<string>;
}

export function buildChronicleWorldGeometry(
  args: BuildWorldGeometryArgs,
): ChronicleWorldGeometry {
  const {
    events,
    lanes,
    pxPerDay,
    originDay,
    density,
    labelsOn,
    relations,
    causalConflictPairs,
  } = args;
  const worldView: View = { pxPerDay, viewStartDay: originDay };

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
      const startX = dayToX(worldView, e.startDay);
      const isInterval = e.endDay != null;
      const barWidth = isInterval
        ? Math.max((e.endDay! - e.startDay) * pxPerDay, 52)
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
    keepEmpty: lane.keepEmpty,
    groupId: lane.groupId,
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

  const edges = buildCausalBezier({
    relations,
    centers: pack.centers,
    conflictPairs: causalConflictPairs,
  });

  return {
    spacing,
    pack,
    edges,
    contentHeight: pack.totalHeight,
    markerById,
    originDay,
    pxPerDay,
  };
}

export function projectChronicleWorldGeometry(args: {
  world: ChronicleWorldGeometry;
  view: View;
  trackW: number;
  calendar: ChronicleCalendar;
  hasCalendarAxis: boolean;
  dataStart: number;
  dataEnd: number;
  lang?: DateLang;
}): ChronicleLayout {
  const {
    world,
    view,
    trackW,
    calendar,
    hasCalendarAxis,
    dataStart,
    dataEnd,
    lang,
  } = args;
  const ticks = adaptiveTicks({
    pxPerDay: view.pxPerDay,
    viewStartDay: view.viewStartDay,
    trackW,
    // Pan preview は React/layout を再計算せず最大1画面ぶん DOM transform
    // する。目盛りも同じ範囲だけ overscan し、生成量を viewport 比で有界に保つ。
    overscanPx: trackW,
    calendar,
    hasCalendarAxis,
    lang,
  });
  return {
    spacing: world.spacing,
    pack: world.pack,
    ticks,
    edges: world.edges,
    scroll: scrollGeom({ view, trackW, dataStart, dataEnd }),
    contentHeight: world.contentHeight,
    minorGridX: ticks.minor.map((tick) => tick.x),
    majorGridX: ticks.major.map((tick) => tick.x),
    markerById: world.markerById,
    worldOffsetX: dayToX(view, world.originDay),
  };
}

export function buildChronicleLayout(args: BuildLayoutArgs): ChronicleLayout {
  const world = buildChronicleWorldGeometry({
    events: args.events,
    lanes: args.lanes,
    pxPerDay: args.view.pxPerDay,
    originDay: args.view.viewStartDay,
    density: args.density,
    labelsOn: args.labelsOn,
    relations: args.relations,
    causalConflictPairs: args.causalConflictPairs,
  });
  return projectChronicleWorldGeometry({
    world,
    view: args.view,
    trackW: args.trackW,
    calendar: args.calendar,
    hasCalendarAxis: args.hasCalendarAxis,
    dataStart: args.dataStart,
    dataEnd: args.dataEnd,
    lang: args.lang,
  });
}

/** causalConflicts から `${cause}|${effect}` の集合を作る小ヘルパ。 */
export function causalConflictPairSet(
  conflicts: { causeId: string; effectId: string }[],
): Set<string> {
  return new Set(conflicts.map((c) => `${c.causeId}|${c.effectId}`));
}
