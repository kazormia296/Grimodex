import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import type { ReorderGranularity, ReorderUnit } from "./types";
import {
  flatRangeToPm,
  pmPosToFlatOffset,
  resolveParagraphAtPos,
  resolveParagraphAtSelection,
  type ResolvedParagraph,
} from "./paragraphFlat";
import { splitSentences } from "./sentenceSplit";
import {
  fetchBunsetsuUnits,
  getBunsetsuUnitsForText,
  isJapanese,
} from "./bunsetsuSegmenter";
import {
  buildAdjacentUnitSwapTransaction,
  findUnitIndexAtFlatOffset,
} from "./reorderTransaction";
import {
  currentUnitsFromOrder,
  identityOrder,
  slotAtFlatOffset,
  slotOfOriginal,
  swapSlots,
} from "./reorderPermutation";
import { effectiveGranularity } from "./ParagraphReorderExtension";
import { swapBlockAt } from "@/features/editor/ParagraphMoveExtension";
import {
  acquireModifierListeners,
  useReorderModifierStore,
  type ReorderModifierMode,
} from "./reorderModifierStore";

/** 進行中の unit ドラッグ状態（プラグイン状態として各 view ごとに保持）。 */
interface UnitDragState {
  blockPos: number;
  units0: ReorderUnit[];
  order: number[];
  /** ドラッグ中 unit の元 index（現在 slot は order から逆引き）。 */
  draggedOriginal: number;
}

interface UiPluginState {
  mode: ReorderModifierMode;
  decorations: DecorationSet;
  /** この view で進行中の unit ドラッグ（無ければ null）。 */
  drag: UnitDragState | null;
}

interface ReorderUiMeta {
  refresh?: boolean;
  /** キーが存在すれば drag を更新（null でクリア）。 */
  drag?: UnitDragState | null;
}

export const reorderUiKey = new PluginKey<UiPluginState>("reorderInteraction");

/** 色帯のサイクル数（隣接単位を視覚的に分離する）。 */
const BAND_COUNT = 5;

const GRIP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>';

// 進行中ドラッグの window リスナ解除関数（同時に 1 つだけ = 単一マウス）。
// プラグイン destroy 時に呼び、破棄済み view への dispatch とリスナ leak を防ぐ。
let activeDragCleanup: (() => void) | null = null;
let prefetchingText: string | null = null;

/** テストからモジュール状態を掃除する。 */
export function __resetReorderInteractionForTest(): void {
  if (activeDragCleanup) activeDragCleanup();
  activeDragCleanup = null;
  prefetchingText = null;
}

/** テスト用: ドラッグ orchestration を直接起動する（posAtCoords はテストで stub）。 */
export const __reorderDragTestHooks = {
  startUnitDrag: (
    view: EditorView,
    blockPos: number,
    units0: ReorderUnit[],
    startSlot: number,
  ) => startUnitDrag(view, blockPos, units0, startSlot),
  startBlockDrag: (view: EditorView, startIndex: number) =>
    startBlockDrag(view, startIndex),
};

function dispatchUiMeta(view: EditorView, meta: ReorderUiMeta): void {
  try {
    view.dispatch(view.state.tr.setMeta(reorderUiKey, meta));
  } catch {
    // view が破棄済みの場合は無視。
  }
}

function refreshDecorations(view: EditorView): void {
  dispatchUiMeta(view, { refresh: true });
}

// ── units 解決（任意段落・粒度）────────────────────────────────────
function unitsForResolved(
  resolved: ResolvedParagraph,
  granularity: ReorderGranularity,
  language: string | undefined,
): ReorderUnit[] | null {
  if (granularity === "bunsetsu" && isJapanese(language)) {
    const bunsetsu = getBunsetsuUnitsForText(resolved.flat.text);
    if (bunsetsu && bunsetsu.length > 1) return bunsetsu;
    // cache miss → 文粒度フォールバック（prefetch は plugin.update が担う）。
  }
  const sentences = splitSentences(resolved.flat.text, language);
  return sentences.length > 0 ? sentences : null;
}

// ── 装飾ビルド ────────────────────────────────────────────────────
function unitBandDecorations(
  resolved: ResolvedParagraph,
  units: ReorderUnit[],
  activeIndex: number,
  dragging: boolean,
): Decoration[] {
  const decos: Decoration[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u.to <= u.from) continue; // 空 unit ガード（flatRangeToPm は空で throw）
    let pm: { from: number; to: number };
    try {
      pm = flatRangeToPm(resolved.flat, u.from, u.to);
    } catch {
      continue;
    }
    const classes = ["reorder-unit", `reorder-unit-c${i % BAND_COUNT}`];
    if (i === activeIndex) classes.push("reorder-unit-active");
    if (dragging && i === activeIndex) classes.push("reorder-unit-dragging");
    decos.push(
      Decoration.inline(
        pm.from,
        pm.to,
        { class: classes.join(" "), "data-reorder-unit": String(i) },
        { reorderUnit: true },
      ),
    );
  }
  return decos;
}

function buildAltShiftDecorations(
  state: EditorState,
  drag: UnitDragState | null,
): Decoration[] {
  // ドラッグ中はスナップショット units を使い、途中で再セグメント（文節→文へ
  // 化ける）しないようにする。drag はプラグイン状態なので view ごとに独立。
  if (drag) {
    const resolved = resolveParagraphAtPos(state, drag.blockPos);
    if (!resolved) return [];
    const cu = currentUnitsFromOrder(drag.units0, drag.order);
    const activeSlot = slotOfOriginal(drag.order, drag.draggedOriginal);
    return unitBandDecorations(resolved, cu, activeSlot, true);
  }

  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return [];
  const language = getCurrentProjectLanguage();
  const granularity = effectiveGranularity(state, language);
  const units = unitsForResolved(resolved, granularity, language);
  if (!units || units.length <= 1) return [];
  const caretFlat = pmPosToFlatOffset(resolved.flat, state.selection.from);
  const activeIndex = findUnitIndexAtFlatOffset(units, caretFlat);
  return unitBandDecorations(resolved, units, activeIndex, false);
}

function createBlockHandle(
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
): HTMLElement {
  const el = document.createElement("span");
  el.className = "reorder-block-handle";
  el.setAttribute("contenteditable", "false");
  el.setAttribute("data-reorder-handle", "");
  el.setAttribute("role", "button");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = GRIP_SVG;
  el.addEventListener("mousedown", (e) => {
    // 平常クリックの caret 移動・テキスト選択を抑止し、ドラッグへ入る。
    e.preventDefault();
    e.stopPropagation();
    if (useReorderModifierStore.getState().mode !== "alt") return;
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos == null) return;
    const startIndex = view.state.doc.resolve(pos).index(0);
    startBlockDrag(view, startIndex);
  });
  return el;
}

function buildAltDecorations(doc: ProseMirrorNode): Decoration[] {
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    // leaf/atom の最上位ブロック（scene-break 等）にはハンドルを出さない
    // （content 先頭が無く widget を正しく置けない。Alt+矢印では移動可）。
    if (node.isLeaf) return;
    const blockStart = offset;
    // ブロックに position:relative を与え、ハンドルを inline-start マージンへ
    // 絶対配置できるようにする。
    decos.push(
      Decoration.node(blockStart, blockStart + node.nodeSize, {
        class: "reorder-block-anchor",
      }),
    );
    decos.push(
      Decoration.widget(blockStart + 1, createBlockHandle, {
        key: "reorder-block-handle",
        side: -1,
        ignoreSelection: true,
      }),
    );
  });
  return decos;
}

function buildDecorations(
  state: EditorState,
  mode: ReorderModifierMode,
  drag: UnitDragState | null,
): DecorationSet {
  const { doc } = state;
  if (mode === "alt") {
    return DecorationSet.create(doc, buildAltDecorations(doc));
  }
  if (mode === "altShift") {
    return DecorationSet.create(doc, buildAltShiftDecorations(state, drag));
  }
  return DecorationSet.empty;
}

// ── ドラッグ（インクリメンタル swap）─────────────────────────────────
function blockIndexAtCoords(
  view: EditorView,
  x: number,
  y: number,
): number | null {
  const info = view.posAtCoords({ left: x, top: y });
  if (!info) return null;
  const $pos = view.state.doc.resolve(info.pos);
  if ($pos.depth < 1) return null;
  return $pos.index(0);
}

function startBlockDrag(view: EditorView, startIndex: number): void {
  let currentIndex = startIndex;
  const move = (ev: MouseEvent) => {
    if (useReorderModifierStore.getState().mode !== "alt") {
      end();
      return;
    }
    const target = blockIndexAtCoords(view, ev.clientX, ev.clientY);
    if (target == null) return;
    let guard = 0;
    while (currentIndex !== target && guard++ < 2000) {
      const dir: -1 | 1 = target > currentIndex ? 1 : -1;
      if (!swapBlockAt(view, currentIndex, dir)) break;
      currentIndex += dir;
    }
  };
  const removeListeners = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", end, true);
    if (activeDragCleanup === removeListeners) activeDragCleanup = null;
  };
  const end = () => removeListeners();
  activeDragCleanup?.();
  activeDragCleanup = removeListeners;
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", end, true);
}

function startUnitDrag(
  view: EditorView,
  blockPos: number,
  units0: ReorderUnit[],
  startSlot: number,
): void {
  const n = units0.length;
  let order = identityOrder(n);
  const draggedOriginal = order[startSlot]!;
  // 初期ドラッグ状態を **このview の** プラグイン状態へ入れる。
  dispatchUiMeta(view, {
    refresh: true,
    drag: { blockPos, units0, order, draggedOriginal },
  });

  const move = (ev: MouseEvent) => {
    if (useReorderModifierStore.getState().mode !== "altShift") {
      end();
      return;
    }
    const info = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
    if (!info) return;
    const resolved = resolveParagraphAtPos(view.state, blockPos);
    if (!resolved) return;
    const flatOffset = pmPosToFlatOffset(resolved.flat, info.pos);
    const targetSlot = slotAtFlatOffset(
      currentUnitsFromOrder(units0, order),
      flatOffset,
    );
    let curSlot = slotOfOriginal(order, draggedOriginal);
    let guard = 0;
    while (curSlot !== targetSlot && guard++ < 2000) {
      const dir: -1 | 1 = targetSlot > curSlot ? 1 : -1;
      const resolvedNow = resolveParagraphAtPos(view.state, blockPos);
      if (!resolvedNow) break;
      const cu = currentUnitsFromOrder(units0, order);
      const res = buildAdjacentUnitSwapTransaction(
        view.state,
        resolvedNow,
        cu,
        curSlot,
        dir,
      );
      if (!res) break;
      const nextOrder = swapSlots(order, curSlot, curSlot + dir);
      // swap の doc 変更と同じ transaction で drag(order) を運ぶ → 同期 apply が
      // 新 doc と一致した order で色帯を組む（1手遅れのちらつきを防ぐ）。
      res.tr.setMeta(reorderUiKey, {
        drag: { blockPos, units0, order: nextOrder, draggedOriginal },
      });
      view.dispatch(res.tr);
      order = nextOrder;
      curSlot += dir;
    }
  };
  const removeListeners = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", end, true);
    if (activeDragCleanup === removeListeners) activeDragCleanup = null;
  };
  const end = () => {
    removeListeners();
    dispatchUiMeta(view, { refresh: true, drag: null });
  };
  activeDragCleanup?.();
  activeDragCleanup = removeListeners;
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", end, true);
}

/** Alt+Shift+mousedown で unit ドラッグを開始（可能なら true）。 */
function tryStartUnitDragFromMouse(
  view: EditorView,
  event: MouseEvent,
): boolean {
  if (useReorderModifierStore.getState().mode !== "altShift") return false;
  const info = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!info) return false;
  const $pos = view.state.doc.resolve(info.pos);
  if ($pos.depth < 1) return false;
  const blockPos = $pos.before(1);
  const resolved = resolveParagraphAtPos(view.state, blockPos);
  if (!resolved) return false; // paragraph 以外は対象外
  const language = getCurrentProjectLanguage();
  const granularity = effectiveGranularity(view.state, language);
  const units0 = unitsForResolved(resolved, granularity, language);
  if (!units0 || units0.length <= 1) return false;
  const flatOffset = pmPosToFlatOffset(resolved.flat, info.pos);
  const startSlot = findUnitIndexAtFlatOffset(units0, flatOffset);
  event.preventDefault();
  startUnitDrag(view, resolved.pos, units0, startSlot);
  return true;
}

// ── bunsetsu prefetch（altShift + 文節 + cache miss 時）──────────────
function maybePrefetchBunsetsu(view: EditorView): void {
  const language = getCurrentProjectLanguage();
  if (effectiveGranularity(view.state, language) !== "bunsetsu") return;
  const resolved = resolveParagraphAtSelection(view.state);
  if (!resolved) return;
  const text = resolved.flat.text;
  if (getBunsetsuUnitsForText(text)) return;
  if (prefetchingText === text) return;
  prefetchingText = text;
  void fetchBunsetsuUnits(text)
    .then(() => {
      if (prefetchingText === text) prefetchingText = null;
      refreshDecorations(view);
    })
    .catch(() => {
      if (prefetchingText === text) prefetchingText = null;
    });
}

export const ReorderInteractionExtension = Extension.create({
  name: "reorderInteraction",

  addProseMirrorPlugins() {
    return [
      new Plugin<UiPluginState>({
        key: reorderUiKey,
        state: {
          init(): UiPluginState {
            return {
              mode: "none",
              decorations: DecorationSet.empty,
              drag: null,
            };
          },
          apply(tr, prev, _oldState, newState): UiPluginState {
            const mode = useReorderModifierStore.getState().mode;
            const meta = tr.getMeta(reorderUiKey) as ReorderUiMeta | undefined;
            const drag =
              meta && "drag" in meta ? (meta.drag ?? null) : prev.drag;
            const needRebuild =
              meta?.refresh === true ||
              (meta && "drag" in meta) ||
              mode !== prev.mode ||
              tr.docChanged ||
              (mode === "altShift" && tr.selectionSet);
            if (!needRebuild) return prev;
            return {
              mode,
              drag,
              decorations: buildDecorations(newState, mode, drag),
            };
          },
        },
        view(editorView) {
          const release = acquireModifierListeners();
          const unsub = useReorderModifierStore.subscribe(() => {
            refreshDecorations(editorView);
            maybePrefetchBunsetsu(editorView);
          });
          return {
            update(v) {
              if (useReorderModifierStore.getState().mode === "altShift") {
                maybePrefetchBunsetsu(v);
              }
            },
            destroy() {
              // 進行中ドラッグの window リスナを解除（破棄済み view への
              // dispatch 防止）。
              activeDragCleanup?.();
              unsub();
              release();
            },
          };
        },
        props: {
          decorations(state) {
            return reorderUiKey.getState(state)?.decorations ?? null;
          },
          handleDOMEvents: {
            mousedown(view, event) {
              return tryStartUnitDragFromMouse(view, event as MouseEvent);
            },
          },
        },
      }),
    ];
  },
});
