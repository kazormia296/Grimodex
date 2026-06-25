import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import type { PlotThreadLinkRow } from "./api";

/** 「書けた」とみなす scene status。 */
const WRITTEN_STATUS = new Set(["complete", "final"]);

// ───────── 2a 休眠スレッド検出 ─────────

export type DormancyState = "active" | "dormant" | "upcoming" | "unplaced";

export interface ThreadDormancy {
  state: DormancyState;
  /** 現在地点から直近(<=current)マーカーまでの距離。active=0 / マーカー過去のみ→null。 */
  scenesSinceLast: number | null;
  /** 現在地点から次(>current)マーカーまでの距離。なければ null。 */
  scenesUntilNext: number | null;
  /** 最終マーカーが軸末尾から何シーン手前か（立ち消え検出の補助）。 */
  distanceFromTail: number | null;
  lastMarkerIndex: number | null;
  nextMarkerIndex: number | null;
}

/**
 * スレッドの休眠度を「現在開いているシーンの軸 index（currentIndex）」を原点に算出する。
 * `indexById` は computeTimelineSceneOrder 由来の軸 index（active な axisMode 追従）。
 * `indexById` に無いマーカー（archived/note）は除外する。
 */
export function computeThreadDormancy(
  links: PlotThreadLinkRow[],
  threadId: string,
  indexById: Map<string, number>,
  currentIndex: number,
  tailIndex: number,
): ThreadDormancy {
  const cols: number[] = [];
  for (const l of links) {
    if (l.threadId !== threadId) continue;
    const idx = indexById.get(l.nodeId);
    if (idx !== undefined) cols.push(idx);
  }
  if (cols.length === 0) {
    return {
      state: "unplaced",
      scenesSinceLast: null,
      scenesUntilNext: null,
      distanceFromTail: null,
      lastMarkerIndex: null,
      nextMarkerIndex: null,
    };
  }
  cols.sort((a, b) => a - b);
  const distanceFromTail = tailIndex - cols[cols.length - 1];

  const atOrBefore = cols.filter((c) => c <= currentIndex);
  const after = cols.filter((c) => c > currentIndex);
  const nextMarkerIndex = after.length ? after[0] : null;
  const scenesUntilNext =
    nextMarkerIndex !== null ? nextMarkerIndex - currentIndex : null;

  if (atOrBefore.length === 0) {
    return {
      state: "upcoming",
      scenesSinceLast: null,
      scenesUntilNext,
      distanceFromTail,
      lastMarkerIndex: null,
      nextMarkerIndex,
    };
  }

  const lastMarkerIndex = atOrBefore[atOrBefore.length - 1];
  const scenesSinceLast = currentIndex - lastMarkerIndex;
  return {
    state: scenesSinceLast === 0 ? "active" : "dormant",
    scenesSinceLast,
    scenesUntilNext,
    distanceFromTail,
    lastMarkerIndex,
    nextMarkerIndex,
  };
}

// ───────── 2b 起承転結バランス ─────────

export type PhaseCell = "absent" | "drafted" | "written";

export interface ThreadPhaseProgress {
  /** 各 phaseType の状態。 */
  cells: Record<PlotPhaseType, PhaseCell>;
  /** present(drafted|written) な段数。 */
  phasesPresent: number;
  /** 最も後段の present phase（PLOT_PHASE_TYPES 順）。 */
  maxPhaseReached: PlotPhaseType | null;
  /** maxPhaseReached 以前で欠けている phase（型抜け＝climax 抜けで resolve 等）。 */
  anomalies: PlotPhaseType[];
  /** thread が触る scene 数（nodeId dedup）。 */
  linkedSceneCount: number;
  /** うち status=complete|final の scene 数。 */
  writtenSceneCount: number;
}

function isWritten(status: string | null | undefined): boolean {
  return status != null && WRITTEN_STATUS.has(status);
}

/**
 * スレッドの起承転結 5 段の踏破状況と「書けた」量を算出する。
 * `statusByNodeId` は scene の status（complete|final=書けた）。
 */
export function computeThreadPhaseProgress(
  links: PlotThreadLinkRow[],
  threadId: string,
  statusByNodeId: Map<string, string | null>,
): ThreadPhaseProgress {
  const threadLinks = links.filter((l) => l.threadId === threadId);

  const cells = {} as Record<PlotPhaseType, PhaseCell>;
  for (const p of PLOT_PHASE_TYPES) {
    const ofPhase = threadLinks.filter((l) => l.phaseType === p);
    if (ofPhase.length === 0) {
      cells[p] = "absent";
      continue;
    }
    cells[p] = ofPhase.some((l) => isWritten(statusByNodeId.get(l.nodeId)))
      ? "written"
      : "drafted";
  }

  const presentPhases = PLOT_PHASE_TYPES.filter((p) => cells[p] !== "absent");
  const maxPhaseReached =
    presentPhases.length > 0 ? presentPhases[presentPhases.length - 1] : null;

  const anomalies: PlotPhaseType[] = [];
  const maxIdx = maxPhaseReached
    ? PLOT_PHASE_TYPES.indexOf(maxPhaseReached)
    : -1;
  for (let i = 0; i < maxIdx; i++) {
    if (cells[PLOT_PHASE_TYPES[i]] === "absent") {
      anomalies.push(PLOT_PHASE_TYPES[i]);
    }
  }

  const nodeIds = new Set(threadLinks.map((l) => l.nodeId));
  let writtenSceneCount = 0;
  for (const id of nodeIds) {
    if (isWritten(statusByNodeId.get(id))) writtenSceneCount++;
  }

  return {
    cells,
    phasesPresent: presentPhases.length,
    maxPhaseReached,
    anomalies,
    linkedSceneCount: nodeIds.size,
    writtenSceneCount,
  };
}
