import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { DURATIONS, easeOutFn } from "@/lib/animation";

/**
 * レーン並べ替えの入れ替えアニメ（Timeline の Thread と同方式＝手動 rAF FLIP）。
 * レーンの縦位置(top)は pan/zoom では基本変わらず、並べ替え時に置換される。
 * そこで「キー列が同一集合のまま順序だけ変わった」=並べ替えを検出し、旧 top→新 top の
 * 差分を translateY で与えて 0 へ easeOut で減衰させる。zoom 由来の高さ変化(順序不変)や
 * レーン増減(集合変化)では発火しない。決定性の高いロジック部は純関数に分離してテストする。
 */

// キー連結の区切り（codexId / __group_ に現れない記号で署名衝突を回避）。
const SEP = "\n";

export function laneKeySig(keys: string[]): string {
  return keys.join(SEP);
}

/** 同一集合のまま順序だけが変わった（=並べ替え）か。 */
export function detectReorder(
  prevKeys: string[],
  curKeys: string[],
  prevTops: Map<string, number>,
): boolean {
  const sameSet =
    curKeys.length === prevKeys.length &&
    prevKeys.length > 0 &&
    curKeys.every((k) => prevTops.has(k));
  return sameSet && laneKeySig(curKeys) !== laneKeySig(prevKeys);
}

/** 各キーの初期 FLIP オフセット（旧 top − 新 top）。差が小さいキーは省く。 */
export function flipOffsets(
  prevTops: Map<string, number>,
  curTops: Map<string, number>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const [key, top] of curTops) {
    const old = prevTops.get(key);
    if (old != null && Math.abs(old - top) > 0.5) m.set(key, old - top);
  }
  return m;
}

/**
 * 進行中アニメの残差 active（旧 top 基準の translateY）を畳み込んだ初期オフセット。
 * 視覚位置 = prevTop + active なので新基準では (prevTop − curTop) + active。
 * これで 150ms 窓内の連続並べ替えでも現在の見た目から連続してスライドする。
 * active が空なら flipOffsets と同じ。
 */
export function flipOffsetsContinuous(
  prevTops: Map<string, number>,
  curTops: Map<string, number>,
  active: Map<string, number>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const [key, top] of curTops) {
    const old = prevTops.get(key);
    if (old == null) continue;
    const v = old - top + (active.get(key) ?? 0);
    if (Math.abs(v) > 0.5) m.set(key, v);
  }
  return m;
}

export interface LaneTop {
  key: string;
  top: number;
}

/**
 * 並べ替え時のみ発火する translateY オフセット Map（key→px）を返す。
 * 値は毎フレーム 0 へ減衰し、整定後は空 Map。reduced 時は常に空（即時整列）。
 */
export function useLaneReorderTween(
  lanes: LaneTop[],
  reduced: boolean,
): Map<string, number> {
  const prevKeysRef = useRef<string[]>([]);
  const prevTopsRef = useRef<Map<string, number>>(new Map());
  const offsetsRef = useRef<Map<string, number>>(new Map());
  const initialRef = useRef<Map<string, number>>(new Map());
  const startRef = useRef(0);
  const rafRef = useRef(0);
  const [, force] = useReducer((c: number) => (c + 1) & 0xffff, 0);

  // 高さ/順序のどちらが変わっても effect を回す（prevTops を最新へ保つため）。
  const topsSig = lanes.map((l) => `${l.key}:${Math.round(l.top)}`).join(SEP);

  useLayoutEffect(() => {
    const curKeys = lanes.map((l) => l.key);
    const curTops = new Map(lanes.map((l) => [l.key, l.top]));
    const isReorder = detectReorder(
      prevKeysRef.current,
      curKeys,
      prevTopsRef.current,
    );
    const prevTops = prevTopsRef.current;
    prevKeysRef.current = curKeys;
    prevTopsRef.current = curTops;

    // reduced motion: アニメ途中で ON にされても即時整列（進行中 rAF を止め残差を捨てる）。
    if (reduced) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      if (offsetsRef.current.size) {
        offsetsRef.current = new Map();
        force();
      }
      return;
    }
    if (!isReorder) return;
    if (typeof requestAnimationFrame !== "function") return;

    // 進行中アニメの残差を畳み込み、現在の見た目から連続させる（連続並べ替えのポップ防止）。
    const initial = flipOffsetsContinuous(
      prevTops,
      curTops,
      offsetsRef.current,
    );
    if (initial.size === 0) return;
    initialRef.current = initial;
    offsetsRef.current = new Map(initial);
    startRef.current = 0;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    // 旧位置を先に反映（paint 前の同期再描画）してから rAF で減衰。
    force();
    const dur = DURATIONS.fast * 1000;
    const step = (now: number) => {
      if (!startRef.current) startRef.current = now;
      const p = Math.min(1, (now - startRef.current) / dur);
      const e = easeOutFn(p);
      const next = new Map<string, number>();
      for (const [key, d0] of initialRef.current) {
        const v = d0 * (1 - e);
        if (Math.abs(v) > 0.5) next.set(key, v);
      }
      offsetsRef.current = next;
      force();
      if (p < 1 && next.size > 0) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        offsetsRef.current = new Map();
        rafRef.current = 0;
        force();
      }
    };
    rafRef.current = requestAnimationFrame(step);
    // topsSig 1 つで順序/高さ変化を捕捉する（lanes 配列の identity には依存しない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topsSig, reduced]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return offsetsRef.current;
}
