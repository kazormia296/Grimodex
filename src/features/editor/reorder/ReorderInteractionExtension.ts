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
import {
  buildReorderUnits,
  getSelectionFlatRange,
  isSelectionOverrideUnit,
} from "./reorderUnits";
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
  slotOfOriginal,
  swapSlots,
} from "./reorderPermutation";
import {
  effectiveGranularity,
  readReorderGranularity,
  reorderKey,
} from "./ParagraphReorderExtension";
import {
  blockRectAtIndex,
  swapBlockAt,
} from "@/features/editor/ParagraphMoveExtension";
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
  /**
   * 直近の decorations 再構築に使った粒度（reorderKey plugin の値をここに
   * 都度スナップショットする）。tiptap の非chain `editor.commands.X()` は
   * コマンド本体の実行が終わった**後**に実際の view.dispatch を行うため、
   * コマンド内から zustand store 経由で外部通知しても、その時点では
   * view.state にまだ新粒度が反映されていない（stale dispatch 順序問題）。
   * この plugin 自身が newState から直接粒度を読んで変化を検出することで、
   * 外部ストアの通知タイミングに依存せず確実に rebuild する。
   */
  granularity: ReorderGranularity;
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
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>';

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
  state: EditorState,
  resolved: ResolvedParagraph,
  granularity: ReorderGranularity,
  language: string | undefined,
): ReorderUnit[] | null {
  return buildReorderUnits(state, resolved, granularity, language);
}

// ── 装飾ビルド ────────────────────────────────────────────────────
function unitBandDecorations(
  resolved: ResolvedParagraph,
  units: ReorderUnit[],
  activeIndex: number,
  dragging: boolean,
  granularity: ReorderGranularity,
  selectionRange: { from: number; to: number } | null,
): Decoration[] {
  const decos: Decoration[] = [];
  const indices =
    granularity === "character" ? [activeIndex] : units.map((_, i) => i);

  for (const i of indices) {
    const u = units[i];
    if (!u || u.to <= u.from) continue;
    let pm: { from: number; to: number };
    try {
      pm = flatRangeToPm(resolved.flat, u.from, u.to);
    } catch {
      continue;
    }
    const classes = ["reorder-unit"];
    if (granularity === "character") {
      classes.push("reorder-unit-character");
    } else {
      classes.push(`reorder-unit-c${i % BAND_COUNT}`);
      classes.push(
        granularity === "bunsetsu"
          ? "reorder-unit-bunsetsu"
          : granularity === "phrase"
            ? "reorder-unit-phrase"
            : granularity === "word"
              ? "reorder-unit-word"
              : "reorder-unit-sentence",
      );
    }
    if (isSelectionOverrideUnit(u, selectionRange)) {
      classes.push("reorder-unit-selection-override");
    }
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
  granularity: ReorderGranularity,
): Decoration[] {
  const language = getCurrentProjectLanguage();
  const selectionRange = (() => {
    if (drag) {
      const resolved = resolveParagraphAtPos(state, drag.blockPos);
      return resolved ? getSelectionFlatRange(state, resolved) : null;
    }
    const resolved = resolveParagraphAtSelection(state);
    return resolved ? getSelectionFlatRange(state, resolved) : null;
  })();

  // ドラッグ中はスナップショット units を使い、途中で再セグメントしない。
  if (drag) {
    const resolved = resolveParagraphAtPos(state, drag.blockPos);
    if (!resolved) return [];
    const cu = currentUnitsFromOrder(drag.units0, drag.order);
    const activeSlot = slotOfOriginal(drag.order, drag.draggedOriginal);
    return unitBandDecorations(
      resolved,
      cu,
      activeSlot,
      true,
      granularity,
      selectionRange,
    );
  }

  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return [];
  const units = unitsForResolved(state, resolved, granularity, language);
  if (!units) return [];
  const caretFlat = pmPosToFlatOffset(resolved.flat, state.selection.from);
  const activeIndex = findUnitIndexAtFlatOffset(units, caretFlat);
  return unitBandDecorations(
    resolved,
    units,
    activeIndex,
    false,
    granularity,
    selectionRange,
  );
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
  granularity: ReorderGranularity,
): DecorationSet {
  const { doc } = state;
  if (mode === "alt") {
    return DecorationSet.create(doc, buildAltDecorations(doc));
  }
  if (mode === "altShift") {
    return DecorationSet.create(
      doc,
      buildAltShiftDecorations(state, drag, granularity),
    );
  }
  return DecorationSet.empty;
}

// ── ドラッグ（インクリメンタル swap）─────────────────────────────────
/**
 * 隣接ブロックの中点を越えたときだけ 1 段 swap する。
 * 絶対 index ターゲット方式だと swap 後にブロックがカーソル下へ流れ込み、
 * 連続ドラッグが 1 手で止まる（または逆方向へ戻る）ため中点方式を使う。
 */
function trySwapBlockTowardPointer(
  view: EditorView,
  draggedIndex: number,
  clientY: number,
): -1 | 0 | 1 {
  const { doc } = view.state;
  if (draggedIndex > 0) {
    const above = blockRectAtIndex(view, draggedIndex - 1);
    if (above && clientY < above.top + above.height / 2) {
      return swapBlockAt(view, draggedIndex, -1, { animate: true }) ? -1 : 0;
    }
  }
  if (draggedIndex < doc.childCount - 1) {
    const below = blockRectAtIndex(view, draggedIndex + 1);
    if (below && clientY > below.top + below.height / 2) {
      return swapBlockAt(view, draggedIndex, 1, { animate: true }) ? 1 : 0;
    }
  }
  return 0;
}

function startBlockDrag(view: EditorView, startIndex: number): void {
  let draggedIndex = startIndex;
  const move = (ev: MouseEvent) => {
    if (useReorderModifierStore.getState().mode !== "alt") {
      end();
      return;
    }
    let guard = 0;
    while (guard++ < 50) {
      const dir = trySwapBlockTowardPointer(view, draggedIndex, ev.clientY);
      if (dir === 0) break;
      draggedIndex += dir;
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

/**
 * ドラッグ中 unit の隣接 slot の中点を pointer の flatOffset が越えたときだけ
 * 1 段 swap する。旧実装は「pointer が指す slot（絶対 target）」へ向けて
 * 複数手 swap していたが、swap のたびに前後 unit の文字数が変わり flat
 * text 上の境界が動くため、同じ pointer 位置でも次の mousemove で target が
 * 前後に振れて swap→swap-back を繰り返す「fighting/チラツキ」が起きていた
 * （段落ドラッグの 1 手で止まる不具合と同根）。中点判定＋1 手ずつなら、
 * 一度 unit が pointer 側へ来ればそれ以上動かないヒステリシスが効く。
 */
function trySwapUnitTowardPointer(
  view: EditorView,
  blockPos: number,
  units0: ReorderUnit[],
  order: number[],
  draggedOriginal: number,
  flatOffset: number,
): number[] | null {
  const curSlot = slotOfOriginal(order, draggedOriginal);
  const cu = currentUnitsFromOrder(units0, order);
  let dir: -1 | 1 | 0 = 0;
  if (curSlot > 0) {
    const above = cu[curSlot - 1]!;
    if (flatOffset < (above.from + above.to) / 2) dir = -1;
  }
  if (dir === 0 && curSlot < cu.length - 1) {
    const below = cu[curSlot + 1]!;
    if (flatOffset > (below.from + below.to) / 2) dir = 1;
  }
  if (dir === 0) return null;
  const resolvedNow = resolveParagraphAtPos(view.state, blockPos);
  if (!resolvedNow) return null;
  // ドラッグ中の unit がライブ選択（範囲オーバーライド）と一致するなら、swap 後も
  // その範囲を選択し続ける（選択解除による前後 unit との融合を防ぐ）。
  const dragged = cu[curSlot]!;
  const liveSel = getSelectionFlatRange(view.state, resolvedNow);
  const selectionFlatRange =
    liveSel && liveSel.from === dragged.from && liveSel.to === dragged.to
      ? liveSel
      : undefined;
  const language = getCurrentProjectLanguage();
  const granularity = effectiveGranularity(view.state, language);
  const res = buildAdjacentUnitSwapTransaction(
    view.state,
    resolvedNow,
    cu,
    curSlot,
    dir,
    undefined,
    selectionFlatRange,
    language,
    granularity,
  );
  if (!res) return null;
  const nextOrder = swapSlots(order, curSlot, curSlot + dir);
  // swap の doc 変更と同じ transaction で drag(order) を運ぶ → 同期 apply が
  // 新 doc と一致した order で色帯を組む（1手遅れのちらつきを防ぐ）。
  res.tr.setMeta(reorderUiKey, {
    drag: { blockPos, units0, order: nextOrder, draggedOriginal },
  });
  view.dispatch(res.tr);
  return nextOrder;
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
    let guard = 0;
    while (guard++ < 50) {
      const nextOrder = trySwapUnitTowardPointer(
        view,
        blockPos,
        units0,
        order,
        draggedOriginal,
        flatOffset,
      );
      if (!nextOrder) break;
      order = nextOrder;
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
  const units0 = unitsForResolved(view.state, resolved, granularity, language);
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

/** 修飾キー altShift 突入時に文節を先読みする。 */
function onModifierModeChange(
  view: EditorView,
  mode: ReorderModifierMode,
): void {
  refreshDecorations(view);
  if (mode === "altShift") maybePrefetchBunsetsu(view);
}

export const ReorderInteractionExtension = Extension.create({
  name: "reorderInteraction",

  onFocus() {
    // 複数エディタ（split view / Linear mode）でフォーカスが移った際、
    // フッターに「今フォーカスしているエディタ」の粒度を反映する。
    // onFocus は dispatch の外（DOM focus イベント起点）で呼ばれるため、
    // ここで setGranularity しても view.update() 中の再入にはならない。
    useReorderModifierStore
      .getState()
      .setGranularity(readReorderGranularity(this.editor.state));
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<UiPluginState>({
        key: reorderUiKey,
        state: {
          init(_config, state): UiPluginState {
            return {
              mode: "none",
              granularity: readReorderGranularity(state),
              decorations: DecorationSet.empty,
              drag: null,
            };
          },
          apply(tr, prev, _oldState, newState): UiPluginState {
            const mode = useReorderModifierStore.getState().mode;
            // 同一 transaction 内で直接 meta を読む（newState 経由だと、tiptap
            // の ExtensionManager.plugins が extensions 配列を reverse() して
            // から plugin を積むため、拡張の登録順に関わらずこの plugin の
            // apply() が reorderKey 側の apply() より先に呼ばれることがあり、
            // その場合 newState からはまだ更新前の粒度しか読めない）。
            const granMeta = tr.getMeta(reorderKey) as
              | { setGranularity?: ReorderGranularity }
              | undefined;
            const rawGranularity = granMeta?.setGranularity ?? prev.granularity;
            const language = getCurrentProjectLanguage();
            const granularity: ReorderGranularity =
              rawGranularity === "bunsetsu" && !isJapanese(language)
                ? "sentence"
                : rawGranularity === "phrase" && isJapanese(language)
                  ? "sentence"
                  : rawGranularity === "word" && isJapanese(language)
                    ? "sentence"
                    : rawGranularity;
            const meta = tr.getMeta(reorderUiKey) as ReorderUiMeta | undefined;
            const drag =
              meta && "drag" in meta ? (meta.drag ?? null) : prev.drag;
            const needRebuild =
              meta?.refresh === true ||
              (meta && "drag" in meta) ||
              mode !== prev.mode ||
              granularity !== prev.granularity ||
              tr.docChanged ||
              (mode === "altShift" && tr.selectionSet);
            if (!needRebuild) return prev;
            return {
              mode,
              granularity,
              drag,
              decorations: buildDecorations(newState, mode, drag, granularity),
            };
          },
        },
        view(editorView) {
          const release = acquireModifierListeners();
          // フォーカス中エディタの粒度をフッターへミラー（初期表示用。以降は
          // Extension の onFocus / update() で更新する）。
          useReorderModifierStore
            .getState()
            .setGranularity(readReorderGranularity(editorView.state));
          // mode は window の Alt/Shift 押下状態から来る（どの transaction にも
          // 属さない外部イベント）ので、これだけは store 購読で拾って明示的に
          // decorations を作り直す。粒度変化による rebuild は上の apply() が
          // newState を直接見て自己完結で検出する（store 経由にすると、tiptap
          // の非chain commands.X() はコマンド本体の実行が終わった**後**に
          // 初めて実 dispatch するため、コマンド内で store を更新した時点では
          // まだ view.state に新粒度が反映されておらず、rebuild が古い粒度の
          // まま握りつぶされる不具合があった）。
          const unsub = useReorderModifierStore.subscribe((state, prev) => {
            if (state.mode !== prev.mode) {
              onModifierModeChange(editorView, state.mode);
            }
          });
          return {
            update(v) {
              // このエディタの実粒度をフッター表示用にミラー。decorations の
              // rebuild は apply() 側で完結しているので、ここでの store 通知が
              // 追加 dispatch を誘発することはない（このリスナは mode 変化
              // のみを見る）。
              useReorderModifierStore
                .getState()
                .setGranularity(readReorderGranularity(v.state));
              // altShift 中にキャレット/クリックで段落を移動した場合の文節
              // prefetch。fetch 自体は非同期なので dispatch の再入にはならない。
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
