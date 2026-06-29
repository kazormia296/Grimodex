import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EventKind, EventPrecision } from "@/db/schema";
import { laneColorFor } from "./laneColor";

/** マーカー描画に必要な出来事の表示情報。 */
export interface MarkerEvent {
  id: string;
  title: string;
  kind: EventKind;
  precision: EventPrecision;
  secret: boolean;
  /** scene 参照あり=実線/中身あり、なし=オフページ（中空グリフ）。 */
  sceneLinked: boolean;
  primaryCodexId: string | null;
}

export interface EventMarkerProps {
  event: MarkerEvent;
  /** 絶対配置 left（lanePack 由来＝point は startX-9）。 */
  left: number;
  top: number;
  tokenH: number;
  maxTok: number;
  isInterval: boolean;
  barWidth: number | null;
  selected: boolean;
  conflict: boolean;
  /** Timeline で選択中のシーンに紐づく出来事（淡いリング強調）。 */
  related?: boolean;
  labelsOn: boolean;
  /** 期間端の伸縮ハンドルを出すか（interval かつ非ロック時）。 */
  resizable?: boolean;
  /** ドラッグ中の追従オフセット（px）。設定中はマーカーを translate して持ち上げる。 */
  dragOffset?: { dx: number; dy: number } | null;
  /** 因果エッジ接続用ハンドルを出すか（選択中＆非ロック）。D&D で別マーカーへ接続。 */
  edgeHandle?: boolean;
  /** ホバー時カーソル（非ロック=pointer/手、ロック=default）。 */
  cursor?: CSSProperties["cursor"];
  onSelect: () => void;
}

const BIRTH = "oklch(0.6 0.14 150)";
const DEATH = "oklch(0.5 0.07 25)";
const AMBER = "#e0a23a";
const ACCENT = "var(--primary)";

const mix = (c: string, pct: number, to: string) =>
  `color-mix(in oklch, ${c} ${pct}%, ${to})`;

/**
 * 1 出来事を DOM トークンとして描く（point=ピル / interval=帯）。
 * 色は lane（primaryCodexId 由来の安定 oklch）＋種別の意味色。テーマ非依存に
 * するため塗りは transparent への color-mix で重ねる（ダークでも破綻しない）。
 */
export function EventMarker({
  event,
  left,
  top,
  tokenH,
  maxTok,
  isInterval,
  barWidth,
  selected,
  conflict,
  related = false,
  labelsOn,
  resizable = false,
  dragOffset = null,
  edgeHandle = false,
  cursor = "pointer",
  onSelect,
}: EventMarkerProps) {
  const { t } = useTranslation();
  const lc = laneColorFor(event.primaryCodexId);
  const ring = selected
    ? `0 0 0 3px ${mix(ACCENT, 16, "transparent")},0 2px 7px rgba(0,0,0,.12)`
    : related
      ? `0 0 0 3px ${mix(ACCENT, 12, "transparent")}`
      : undefined;
  // 確度の外周線は**確度のみ**で決める（オフページは glyph の中空表現で別途示すので
  // border は奪わない＝確度の差を常に視認できる）。solid=確定 / dashed=おおよそ /
  // dotted=不明。線種に加え確度チップ（後述）で確実に判別できるようにする。
  const borderStyle: CSSProperties["borderStyle"] =
    event.precision === "unknown"
      ? "dashed"
      : event.precision === "approx"
        ? "dotted"
        : "solid";
  const borderWidth = event.precision === "exact" ? 1 : 1.6;
  // ボーダー色: 矛盾=AMBER（最優先）。選択は ring で示し色は奪わない（確度を隠さない）。
  const baseBorder = conflict
    ? AMBER
    : mix(lc, isInterval ? 34 : 50, "transparent");

  let container: CSSProperties;
  if (isInterval) {
    container = {
      position: "absolute",
      left,
      top,
      width: Math.max(barWidth ?? 52, 52),
      height: tokenH,
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "0 9px",
      background: mix(lc, 14, "transparent"),
      borderWidth,
      borderStyle,
      borderColor: baseBorder,
      borderRadius: 7,
      overflow: "hidden",
      whiteSpace: "nowrap",
      boxShadow: ring,
      zIndex: selected ? 9 : 5,
    };
  } else {
    container = {
      position: "absolute",
      left,
      top,
      height: tokenH,
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "0 10px 0 8px",
      background: event.sceneLinked
        ? "var(--card)"
        : mix("var(--card)", 96, "var(--foreground)"),
      borderWidth,
      borderStyle,
      borderColor: baseBorder,
      borderRadius: tokenH / 2,
      boxShadow: ring ?? "0 1px 2px rgba(0,0,0,.07)",
      maxWidth: maxTok,
      whiteSpace: "nowrap",
      zIndex: selected ? 9 : 5,
    };
  }
  // 不明=破線＋減光、おおよそ=点線＋わずか減光（確定との差を視覚化）。
  if (event.precision === "unknown") container.opacity = 0.8;
  else if (event.precision === "approx") container.opacity = 0.92;

  // ドラッグ追従: ポインタへ translate し前面へ。pointer-events を切り落下先（別マーカー）を
  // elementFromPoint で拾えるようにする。
  if (dragOffset) {
    container.transform = `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`;
    container.zIndex = 30;
    container.pointerEvents = "none";
    container.boxShadow = "0 4px 12px rgba(0,0,0,.18)";
    container.opacity = 0.96;
  }

  // 先頭グリフ＝凡例と同形（出生=三角 / 死亡=菱形 / 出来事=丸 / 期間=帯）。
  // 点(●/◯)・期間(▬/▭)と同様、出生/死亡も scene 未参照はオフページ＝中空(outline)で示す。
  // 三角の中空は単一 span の CSS border トリックでは描けないため、出生/死亡は SVG（塗り/枠）で描く。
  const kindTitle =
    event.kind === "birth"
      ? t("chronicle.kind.birth", "出生")
      : event.kind === "death"
        ? t("chronicle.kind.death", "死亡")
        : undefined;

  let glyphNode: ReactNode;
  if (event.kind === "birth" || event.kind === "death") {
    const isBirth = event.kind === "birth";
    const shapeColor = isBirth ? BIRTH : DEATH;
    const points = isBirth
      ? "6,1 11,10 1,10" // 上向き三角
      : "5.5,1 10,5.5 5.5,10 1,5.5"; // 菱形
    glyphNode = (
      // testid/title は span に載せる（React の SVG 型は title 属性を持たないため）。
      <span
        data-testid="marker-glyph"
        title={kindTitle}
        style={{ flex: "none", display: "flex" }}
      >
        <svg
          width={isBirth ? 12 : 11}
          height={11}
          viewBox={isBirth ? "0 0 12 11" : "0 0 11 11"}
          style={{ display: "block", overflow: "visible" }}
        >
          <polygon
            points={points}
            strokeLinejoin="round"
            style={{
              // on-page=塗り / off-page=中空（card 地＋枠）。
              fill: event.sceneLinked ? shapeColor : "var(--card)",
              stroke: shapeColor,
              strokeWidth: event.sceneLinked ? 0 : 1.5,
            }}
          />
        </svg>
      </span>
    );
  } else {
    // 点(●/◯)・期間(▬/▭)は CSS span。
    let glyph: CSSProperties;
    if (isInterval) {
      // 期間＝凡例「期間」と同形（横長の角丸帯）。on-page=塗り / off-page=中空。
      glyph = event.sceneLinked
        ? {
            flex: "none",
            width: 14,
            height: 8,
            borderRadius: 3.5,
            background: mix(lc, 30, "transparent"),
            border: `1px solid ${mix(lc, 55, "transparent")}`,
            boxSizing: "border-box",
          }
        : {
            flex: "none",
            width: 14,
            height: 8,
            borderRadius: 3.5,
            background: "var(--card)",
            border: `1.5px solid ${lc}`,
            boxSizing: "border-box",
          };
    } else if (!event.sceneLinked) {
      // 汎用のオフページ（scene 未参照）＝中空丸 ◯（凡例で明示）。
      glyph = {
        flex: "none",
        width: 11,
        height: 11,
        borderRadius: "50%",
        border: `2px solid ${lc}`,
        background: "var(--card)",
        boxSizing: "border-box",
      };
    } else {
      // 汎用＝塗りつぶしの丸 ●（凡例の「イベント」）。
      glyph = {
        flex: "none",
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: lc,
      };
    }
    glyphNode = (
      <span data-testid="marker-glyph" title={kindTitle} style={glyph} />
    );
  }

  // 種別は先頭グリフ（凡例と同じ三角/菱形/丸）で示すため、文字タグは廃止。
  // 確度チップ（確定は無印・おおよそ/不明のみ明示）。線種だけでは判別しづらい問題への対策。
  const precisionTag =
    event.precision === "approx"
      ? { label: t("chronicle.precisionShort.approx", "約"), color: AMBER }
      : event.precision === "unknown"
        ? { label: t("chronicle.precisionShort.unknown", "?"), color: AMBER }
        : null;

  return (
    <button
      type="button"
      data-event-id={event.id}
      data-selected={selected || undefined}
      onClick={onSelect}
      title={event.title || t("chronicle.untitled", "無題の出来事")}
      style={{
        ...container,
        cursor,
        font: "inherit",
        color: "var(--foreground)",
        textAlign: "left",
      }}
    >
      {isInterval && resizable && (
        <>
          <span
            data-resize="start"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: 7,
              height: "100%",
              cursor: "ew-resize",
              zIndex: 2,
            }}
          />
          <span
            data-resize="end"
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              width: 7,
              height: "100%",
              cursor: "ew-resize",
              zIndex: 2,
            }}
          />
        </>
      )}
      {edgeHandle && (
        <span
          data-edge-handle
          title={t("chronicle.edgeHandleHint", "ドラッグで因果エッジを作成")}
          style={{
            position: "absolute",
            right: 3,
            top: "50%",
            transform: "translateY(-50%)",
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: ACCENT,
            border: "1.5px solid var(--card)",
            cursor: "crosshair",
            zIndex: 3,
          }}
        />
      )}
      {glyphNode}
      {labelsOn && (
        <span
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          {event.title || t("chronicle.untitled", "無題の出来事")}
        </span>
      )}
      {precisionTag && (
        <span
          data-testid="precision-tag"
          title={t(`chronicle.precision.${event.precision}`, event.precision)}
          style={{
            flex: "none",
            fontSize: 10,
            lineHeight: 1,
            padding: "2px 5px",
            borderRadius: 4,
            background: mix(precisionTag.color, 16, "transparent"),
            color: mix(precisionTag.color, 72, "var(--foreground)"),
            fontWeight: 700,
          }}
        >
          {precisionTag.label}
        </span>
      )}
      {event.secret && (
        <span
          data-testid="secret-tag"
          style={{
            flex: "none",
            fontSize: 10,
            lineHeight: 1,
            padding: "2px 5px",
            borderRadius: 4,
            background: mix(AMBER, 18, "transparent"),
            color: mix(AMBER, 72, "var(--foreground)"),
          }}
        >
          {t("chronicle.secretTag", "秘匿")}
        </span>
      )}
      {conflict && (
        <span
          data-testid="conflict-badge"
          style={{
            position: "absolute",
            top: -6,
            right: -6,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: AMBER,
            color: "#fff",
            fontSize: 10,
            lineHeight: "14px",
            textAlign: "center",
            fontWeight: 700,
            boxShadow: "0 0 0 1.5px var(--card)",
          }}
        >
          !
        </span>
      )}
    </button>
  );
}
