import type {
  CSSProperties,
  ReactNode,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "lucide-react";
import type { EventKind, EventPrecision } from "@/db/schema";
import { CSS_DURATIONS, CSS_EASINGS } from "@/lib/animation";
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
  /** Scene-Event union: これがシーン由来トークン（scene:*）なら true。角丸スクエアで区別。 */
  isScene?: boolean;
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
  /** レーン入れ替えアニメの縦オフセット（px）。translateY で旧位置→新位置へ。 */
  offsetY?: number;
  /** 因果エッジ接続用ハンドルを出すか（選択中＆非ロック）。D&D で別マーカーへ接続。 */
  edgeHandle?: boolean;
  /** ホバー時カーソル（非ロック=pointer/手、ロック=default）。 */
  cursor?: CSSProperties["cursor"];
  /** 因果ホバー時、連結チェーン外なので淡色化する。 */
  dimmed?: boolean;
  /** ホバー開始/終了（因果チェーン強調の駆動）。 */
  onHover?: (hovering: boolean) => void;
  /** クリック選択（修飾キー判定のため MouseEvent を渡す）。 */
  onSelect: (e: ReactMouseEvent) => void;
}

const BIRTH = "oklch(0.6 0.14 150)";
const DEATH = "oklch(0.5 0.07 25)";
const AMBER = "#e0a23a";
const ACCENT = "var(--primary)";

const mix = (c: string, pct: number, to: string) =>
  `color-mix(in oklch, ${c} ${pct}%, ${to})`;

/**
 * 期間（interval）の両端にホバー時だけ出すリサイズグリップ（縦の小バー）。
 * 既定は opacity-0 で、親ボタンの group-hover で淡くフェードイン（duration/easing は
 * animation.ts の正本から）。pointer-events は親の data-resize 帯に委ねる（none）。
 */
const RESIZE_GRIP: CSSProperties = {
  width: 3,
  height: "58%",
  borderRadius: 2,
  background: mix("var(--foreground)", 42, "transparent"),
  pointerEvents: "none",
  transition: `opacity ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
};

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
  offsetY = 0,
  edgeHandle = false,
  cursor = "pointer",
  dimmed = false,
  onHover,
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
      // overflow:hidden はコンテナに置かない。角外(top:-6/right:-6)に浮く conflict
      // バッジまで切り取ってしまうため、内容クリップは下の marker-content 層に委ねる。
      // 背景の角丸は border-radius が自動でクリップするので overflow は不要。
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
  } else if (offsetY) {
    // レーン入れ替えアニメ（ドラッグ追従と排他。GPU フレンドリな transform のみ）。
    container.transform = `translateY(${offsetY}px)`;
  }

  // 因果ホバー: 連結チェーン外は淡色化（Timeline のスレッドホバーと同じ 0.28）。
  if (dimmed) container.opacity = 0.28;
  container.transition = `opacity ${CSS_DURATIONS.normal} ${CSS_EASINGS.easeOut}`;

  // 先頭グリフは**種別のみ**で形が決まる（出生=三角 / 死亡=菱形 / 出来事=丸 / 期間=帯）。
  // 常に塗り。scene リンク有無（オンページ/オフページ）は形では表さず、右隣の Link
  // アイコン（後述 linkGlyph）で示す。これで点・期間・シーンイベントの見た目が揃う。
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
            style={{ fill: shapeColor }}
          />
        </svg>
      </span>
    );
  } else {
    // 点(●)・期間(▬)は CSS span。いずれも塗り（オフページでも中空にしない）。
    const glyph: CSSProperties = isInterval
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
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: lc,
        };
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

  // ホバー＝open hand（grab）/ ドラッグ追従中＝grab hand（grabbing）。ロック時は cursor=default。
  const effectiveCursor: CSSProperties["cursor"] = dragOffset
    ? "grabbing"
    : cursor;

  // 帯/ピルの中身（グリフ＋ラベル＋確度/秘匿チップ）。interval は固定幅なので
  // marker-content 層でクリップする。conflict バッジはこの層の外（button 直下）に
  // 置くため、角外(top:-6/right:-6)に浮いてもクリップされない。
  const flowContent = (
    <>
      {glyphNode}
      {event.sceneLinked && (
        // オンページ（シーンに登場／シーンイベント）を種別グリフの右に Link アイコンで示す。
        // 形は種別専用にして、点・期間・シーンイベントで見た目を揃える。
        <Link
          data-testid="scene-link-icon"
          aria-label={t("chronicle.onPageHint", "シーンに登場（オンページ）")}
          size={11}
          style={{ flex: "none", opacity: 0.6 }}
        />
      )}
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
          {event.title || t("chronicle.untitled", "無題のイベント")}
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
    </>
  );

  return (
    <button
      type="button"
      data-event-id={event.id}
      data-selected={selected || undefined}
      onClick={onSelect}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
      title={event.title || t("chronicle.untitled", "無題のイベント")}
      className="group"
      style={{
        ...container,
        cursor: effectiveCursor,
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
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              aria-hidden
              data-testid="resize-grip"
              className="opacity-0 group-hover:opacity-100"
              style={RESIZE_GRIP}
            />
          </span>
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
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              aria-hidden
              data-testid="resize-grip"
              className="opacity-0 group-hover:opacity-100"
              style={RESIZE_GRIP}
            />
          </span>
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
      {isInterval ? (
        <span
          data-testid="marker-content"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            height: "100%",
            overflow: "hidden",
          }}
        >
          {flowContent}
        </span>
      ) : (
        flowContent
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
