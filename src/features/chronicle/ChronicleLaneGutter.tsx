import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, GripVertical } from "lucide-react";
import type { PackedLane } from "./chronicleLanePack";
import { laneKeyOf } from "./chronicleLayout";
import { dropIndexByMidpoints, moveToIndex } from "./chronicleLaneOrder";
import { laneColorFor } from "./laneColor";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { CodexEntryPicker } from "./CodexEntryPicker";

export interface ChronicleLaneGutterProps {
  lanes: PackedLane[];
  gutterX: number;
  /** 選択中の出来事が属するレーンキー（codexId or "__unassigned"）。背景を淡く強調。 */
  activeLaneKey: string | null;
  /** 任意 Codex 候補（レーン追加・未割当の割当ドロップダウン用）。 */
  laneOptions?: { id: string; name: string; type: string }[];
  /** 編集ロック中は追加/割当 UI を隠す。 */
  locked?: boolean;
  /** 未割当レーンを群ごと Codex へ割当（groupId=null は基底未割当）。 */
  onAssignGroup?: (groupId: string | null, codexId: string) => void;
  /** レーン追加（空の未割当レーンを増やす）。 */
  onAddLane?: () => void;
  /** 空の未割当（追加）レーンを隠す（×）。 */
  onHideGroup?: (groupId: string) => void;
  /**
   * codex レーンの並べ替え。ドラッグ中は commit=false（表示のみ更新で順次入替え）、
   * ドロップ時に commit=true（永続化）。新しい全 codex 順を渡す。
   */
  onReorderLanes?: (newOrder: string[], commit: boolean) => void;
  /** レーン入れ替えアニメの縦オフセット（key→px）。translateY で旧→新へ。 */
  laneOffsets?: Map<string, number>;
}

/**
 * 左レーンガター（アバター＋名前＋件数）。各セルは pack の lane.height に
 * 合わせ、トラックのレーンと縦位置を揃える。人物=円 / 場所等=角丸 / 未割当=点線。
 * レーン名は Codex ポップオーバー（Editor 本文と同じ）対応。最後尾に「追加」、
 * 未割当レーンには Codex 割当ドロップダウンを出す。
 */
export function ChronicleLaneGutter({
  lanes,
  gutterX,
  activeLaneKey,
  laneOptions = [],
  locked = false,
  onAssignGroup,
  onAddLane,
  onHideGroup,
  onReorderLanes,
  laneOffsets,
}: ChronicleLaneGutterProps) {
  const { t } = useTranslation();
  const [gutterEl, setGutterEl] = useState<HTMLDivElement | null>(null);

  // ── codex レーンの並べ替え（Grid 方式の順次入替え） ──
  // drag 中は対象 codexId のみ保持（dim 用）。位置は live reorder＋FLIP アニメで示す。
  const [drag, setDrag] = useState<{ codexId: string } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const reorderable = !locked && !!onReorderLanes;

  const startReorder = (codexId: string, e: React.MouseEvent) => {
    if (e.button !== 0 || !onReorderLanes || !gutterEl) return;
    e.preventDefault();
    const onReorder = onReorderLanes;
    const startY = e.clientY;
    // ドラッグ開始時に固定スナップショットを取る（Grid 同様、以後は再計測しない）。
    // 中点を固定することで live reorder 中も hit-test が単調＝振動しない。FLIP 中は
    // 画面位置と中点が一時的にズレ得るが 150ms で収束し、確定は mouseup の py で行う。
    // 対象 codex 兄弟（active 含む）の表示順 id と client 中点。
    const baseOrder: string[] = [];
    const baseMids: number[] = []; // baseOrder と同 index の中点（active 含む）
    for (const cell of gutterEl.querySelectorAll<HTMLElement>(
      "[data-lane-id]",
    )) {
      const key = cell.getAttribute("data-lane-id");
      if (!key || key.startsWith("__")) continue; // 未割当は対象外
      const r = cell.getBoundingClientRect();
      baseOrder.push(key);
      baseMids.push((r.top + r.bottom) / 2);
    }
    // active を除いた兄弟中点（挿入 index 算出に使う・固定）。
    const siblingMids = baseMids.filter((_, i) => baseOrder[i] !== codexId);
    // スクロール補正（ドラッグ中スクロールでも中点基準を保つ）。
    const scrollEl = gutterEl.closest<HTMLElement>(".overflow-y-auto");
    const initialScrollTop = scrollEl?.scrollTop ?? 0;

    dragCleanupRef.current?.();
    setDrag({ codexId });
    let moved = false;
    let lastOrder = baseOrder;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 3) return;
      moved = true;
      const scrollDelta = (scrollEl?.scrollTop ?? 0) - initialScrollTop;
      const py = ev.clientY + scrollDelta;
      const idx = dropIndexByMidpoints(py, siblingMids);
      const next = moveToIndex(baseOrder, codexId, idx);
      if (next.join("\n") !== lastOrder.join("\n")) {
        lastOrder = next;
        onReorder(next, false); // 表示のみ（順次入替え）。永続化はドロップ時。
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      dragCleanupRef.current = null;
      setDrag(null);
      if (moved && lastOrder.join("\n") !== baseOrder.join("\n")) {
        onReorder(lastOrder, true); // 確定＝永続化。
      }
    };
    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // アンマウント時に進行中ドラッグの document リスナを撤去（取りこぼし防止）。
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const typeJa = (type: string): string =>
    t(`chronicle.laneType.${type}`, type);

  const optionLabel = (o: { name: string; type: string }) =>
    o.type && o.type !== "character"
      ? `${o.name}（${typeJa(o.type)}）`
      : o.name;
  // Spotlight 風ピッカー（Chat と同じ CodexEntryPicker）に渡す候補。
  const pickerOptions = laneOptions.map((o) => ({
    id: o.id,
    name: optionLabel(o),
  }));

  return (
    <div
      ref={setGutterEl}
      data-testid="chronicle-lane-gutter"
      // z-20: 選択マーカー(z-9)が左端で負 left にはみ出してもガターを覆わせない。
      // relative は必須: position が static のままだと z-20 が効かず（z-index は
      // 位置指定要素にしか効かない）、マーカーがレーンヘッダーに重なる（再発防止）。
      // min-h-max も必須: 親スクロール領域（flex row・高さ確定）の flex line は
      // 可視高さで固まるため、stretch だけだとガターの箱が初期可視高さで止まり、
      // それより下のレーンセルは箱の外へオーバーフローする。その領域には不透明背景
      // (bg-card) が塗られず、横スクロールで負 left になったマーカーがヘッダー上に
      // 透けて見える。箱をコンテンツ全高まで伸ばして遮蔽を全レーンに効かせる。
      className="relative z-20 min-h-max flex-none border-r border-border bg-card"
      style={{ width: gutterX }}
    >
      {lanes.map((lane) => {
        const active = laneKeyOf(lane) === activeLaneKey;
        const lc = laneColorFor(lane.codexId);
        const initial = lane.name?.[0] ?? "?";
        const radius = lane.unassigned
          ? "50%"
          : lane.kind === "character"
            ? "50%"
            : "8px";
        const avatarStyle: CSSProperties = lane.unassigned
          ? {
              width: 28,
              height: 28,
              flex: "none",
              borderRadius: "50%",
              border: "1.5px dashed var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted-foreground)",
              fontSize: 13,
            }
          : {
              width: 28,
              height: 28,
              flex: "none",
              borderRadius: radius,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              background: `linear-gradient(145deg, ${lc}, color-mix(in oklch, ${lc} 62%, #000))`,
            };
        const countText =
          t("chronicle.count", "{{count}} 件", { count: lane.count }) +
          (lane.kind && lane.kind !== "character" && !lane.unassigned
            ? ` ・${typeJa(lane.kind)}`
            : "");
        // 空でも表示する未割当（=空）レーンは × で隠せる。
        const isEmptyUnassigned = lane.unassigned && lane.keepEmpty;
        const isCodexLane = !lane.unassigned && !!lane.codexId;
        const isDragged =
          !!drag && drag.codexId === lane.codexId && isCodexLane;
        // 順次入替え＋整定アニメの縦オフセット（FLIP, translateY で旧→新へ減衰）。
        const laneOff = laneOffsets?.get(laneKeyOf(lane)) ?? 0;
        return (
          <div
            key={laneKeyOf(lane)}
            data-lane-id={laneKeyOf(lane)}
            className="relative flex items-center gap-2.5 border-b border-border/60 px-3.5"
            style={{
              height: lane.height,
              boxSizing: "border-box",
              // ドラッグ中の対象レーンは半透明（active の明示）。位置は live reorder。
              opacity: isDragged ? 0.4 : undefined,
              transform: laneOff ? `translateY(${laneOff}px)` : undefined,
              background: active
                ? "color-mix(in oklch, var(--primary) 5%, transparent)"
                : undefined,
            }}
          >
            {isCodexLane && reorderable && (
              <span
                data-reorder-grip={lane.codexId ?? undefined}
                onMouseDown={(e) => startReorder(lane.codexId!, e)}
                title={t("chronicle.reorderLane", "ドラッグでレーンを並べ替え")}
                // p-1 で不可視ヒット域を拡大（タッチ/精密操作の命中率向上）。
                className="absolute top-1/2 z-10 -translate-y-1/2 cursor-grab p-1 text-muted-foreground/45 hover:text-foreground"
                style={{ left: -3, touchAction: "none" }}
              >
                <GripVertical className="size-3.5" />
              </span>
            )}
            <div style={avatarStyle}>{lane.unassigned ? "·" : initial}</div>
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              {lane.unassigned && onAssignGroup && !locked ? (
                // 「未割当」ラベル自体を Spotlight ピッカーに（常時表示）。この未割当
                // レーンの出来事をまとめて選んだ Codex レーンへ割り当てる。
                <CodexEntryPicker
                  value={null}
                  options={pickerOptions}
                  onChange={(id) => {
                    if (id) onAssignGroup(lane.groupId ?? null, id);
                  }}
                  ariaLabel={t("chronicle.assignLane", "レーンへ割当")}
                  placeholder={t("chronicle.unassigned", "未割当")}
                />
              ) : (
                <span
                  // Codex 連携レーンは Editor 本文と同じ codex-highlight ポップオーバー対象。
                  className={`truncate text-[13px] font-medium ${
                    !lane.unassigned && lane.codexId ? "codex-highlight" : ""
                  }`}
                  data-codex-entry-id={
                    !lane.unassigned && lane.codexId ? lane.codexId : undefined
                  }
                  style={{
                    color: lane.unassigned
                      ? "var(--muted-foreground)"
                      : "var(--foreground)",
                    fontStyle: lane.unassigned ? "italic" : undefined,
                  }}
                >
                  {lane.unassigned
                    ? t("chronicle.unassigned", "未割当")
                    : lane.name || t("chronicle.unnamed", "（無名）")}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground">
                {countText}
              </span>
            </div>
            {isEmptyUnassigned && lane.groupId && onHideGroup && !locked && (
              <button
                type="button"
                onClick={() => onHideGroup(lane.groupId!)}
                aria-label={t("chronicle.removeLane", "レーンを隠す")}
                className="flex-none rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}

      {onAddLane && !locked && (
        <button
          type="button"
          onClick={() => onAddLane()}
          className="flex w-full items-center gap-1.5 border-b border-border/60 px-3.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5 flex-none" />
          {t("chronicle.addLane", "レーンを追加")}
        </button>
      )}

      <CodexPopover containerEl={gutterEl} />
    </div>
  );
}
