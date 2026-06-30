import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
  type KeyboardEvent as RKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { CSS_DURATIONS, CSS_EASINGS, useReducedMotion } from "@/lib/animation";

/** 時計盤の寸法（px）。テストからも参照するため export。 */
export const DIAL = 196;
export const CENTER = DIAL / 2;
export const R_OUT = CENTER - 16; // 外周リング（時=1..12 / 分）
export const R_IN = CENTER - 44; // 内周リング（時=0,13..23）
const MID = (R_OUT + R_IN) / 2;
const DEG = Math.PI / 180;

const mod = (a: number, b: number) => ((a % b) + b) % b;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** 中心相対 (dx,dy) → 時計位置 0..11（0=12時方向, 時計回り）。純関数。 */
export function clockPosFromPoint(dx: number, dy: number): number {
  const ang = Math.atan2(dy, dx) / DEG + 90;
  return mod(Math.round(ang / 30), 12);
}
/** 中心相対 (dx,dy) → 時 0..23（内周=0/13..23, 外周=1..12）。純関数。 */
export function hourFromPoint(dx: number, dy: number): number {
  const p = clockPosFromPoint(dx, dy);
  if (Math.hypot(dx, dy) < MID) return p === 0 ? 0 : p + 12; // 内周
  return p === 0 ? 12 : p; // 外周
}
/** 中心相対 (dx,dy) → 分 0,5,..,55。純関数。 */
export function minuteFromPoint(dx: number, dy: number): number {
  return (clockPosFromPoint(dx, dy) * 5) % 60;
}

/** 時計位置 p(0..11) を半径 r 上の座標へ。 */
function ptAt(p: number, r: number): { x: number; y: number } {
  const a = (p * 30 - 90) * DEG;
  return { x: CENTER + r * Math.cos(a), y: CENTER + r * Math.sin(a) };
}
/** 時 h(0..23) の時計位置・リング半径。 */
function hourGeom(h: number): { p: number; r: number } {
  if (h >= 1 && h <= 12) return { p: h % 12, r: R_OUT };
  return { p: h === 0 ? 0 : h - 12, r: R_IN };
}

const HOUR_OUTER = Array.from({ length: 12 }, (_, p) => (p === 0 ? 12 : p));
const HOUR_INNER = Array.from({ length: 12 }, (_, p) => (p === 0 ? 0 : p + 12));
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

export interface ChronicleTimeDialProps {
  /** 現在の時 0..23。 */
  hour: number;
  /** 現在の分 0..59。 */
  minute: number;
  onHour: (h: number) => void;
  onMinute: (m: number) => void;
}

/**
 * 時刻のダイヤル（時計盤）ピッカー。時=外周1..12/内周0,13..23の24時間、分=5分刻み。
 * 盤面のクリック/ドラッグ（最近傍へ吸着）で選択し、針が選択値を指す。時→分は自動で
 * 切替（Material 風）。digital 表示の HH/MM で手動切替、矢印キーで増減も可。
 */
export function ChronicleTimeDial({
  hour,
  minute,
  onHour,
  onMinute,
}: ChronicleTimeDialProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<"hour" | "minute">("hour");
  // 手入力中のフィールドと文字列（未編集時は null＝現在値を表示）。
  const [edit, setEdit] = useState<{ f: "hour" | "minute"; v: string } | null>(
    null,
  );
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const pick = (e: RPointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left - CENTER;
    const dy = e.clientY - r.top - CENTER;
    setEdit(null); // 盤面操作で手入力状態を解除
    if (mode === "hour") onHour(hourFromPoint(dx, dy));
    else onMinute(minuteFromPoint(dx, dy));
  };

  // 手入力（数値）: フォーカスで編集開始＋モード切替、確定(blur/Enter)で clamp して反映。
  const startEdit = (f: "hour" | "minute") => {
    setMode(f);
    setEdit({ f, v: String(f === "hour" ? hour : minute) });
  };
  const typeEdit = (f: "hour" | "minute", raw: string) =>
    setEdit({ f, v: raw.replace(/\D/g, "").slice(0, 2) });
  const commitEdit = (f: "hour" | "minute") => {
    if (edit && edit.f === f && edit.v !== "") {
      const n = parseInt(edit.v, 10);
      if (!Number.isNaN(n)) {
        if (f === "hour") onHour(Math.max(0, Math.min(23, n)));
        else onMinute(Math.max(0, Math.min(59, n)));
      }
    }
    setEdit(null);
  };
  const hhText = edit?.f === "hour" ? edit.v : pad2(hour);
  const mmText = edit?.f === "minute" ? edit.v : pad2(minute);
  const onDown = (e: RPointerEvent) => {
    dragging.current = true;
    ref.current?.setPointerCapture?.(e.pointerId);
    pick(e);
  };
  const onMove = (e: RPointerEvent) => {
    if (dragging.current) pick(e);
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (mode === "hour") setMode("minute"); // 時を決めたら分へ自動遷移
  };
  const onKey = (e: RKeyboardEvent) => {
    const up = e.key === "ArrowUp" || e.key === "ArrowRight";
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
    if (!up && !down) return;
    e.preventDefault();
    if (mode === "hour") onHour(mod(hour + (up ? 1 : -1), 24));
    else onMinute(mod(minute + (up ? 5 : -5), 60));
  };

  const hand = mode === "hour" ? hourGeom(hour) : { p: minute / 5, r: R_OUT };
  const handAngle = hand.p * 30 - 90;
  const end = ptAt(hand.p, hand.r);
  const motion = reduced
    ? undefined
    : `transform ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, width ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, left ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, top ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`;

  const readout = (active: boolean): CSSProperties => ({
    width: 44,
    borderRadius: 7,
    padding: "2px 4px",
    fontSize: 20,
    fontVariantNumeric: "tabular-nums",
    fontWeight: 600,
    textAlign: "center",
    outline: "none",
    border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`,
    background: active
      ? "color-mix(in oklch, var(--primary) 14%, transparent)"
      : "var(--card)",
    color: active ? "var(--primary)" : "var(--foreground)",
  });

  const num = (
    key: string,
    x: number,
    y: number,
    label: string,
    sel: boolean,
    small: boolean,
  ) => (
    <span
      key={key}
      aria-hidden
      style={{
        position: "absolute",
        left: x - 13,
        top: y - 13,
        width: 26,
        height: 26,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        fontSize: small ? 10 : 12,
        fontVariantNumeric: "tabular-nums",
        fontWeight: sel ? 700 : 400,
        color: sel
          ? "var(--primary-foreground)"
          : small
            ? "var(--muted-foreground)"
            : "var(--foreground)",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {label}
    </span>
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-center gap-1">
        <input
          type="text"
          inputMode="numeric"
          data-testid="chronicle-dial-hh"
          value={hhText}
          onFocus={(e) => {
            startEdit("hour");
            e.currentTarget.select?.();
          }}
          onChange={(e) => typeEdit("hour", e.target.value)}
          onBlur={() => commitEdit("hour")}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-label={t("chronicle.dialHour", "時")}
          style={readout(mode === "hour")}
        />
        <span className="text-lg font-semibold text-muted-foreground">:</span>
        <input
          type="text"
          inputMode="numeric"
          data-testid="chronicle-dial-mm"
          value={mmText}
          onFocus={(e) => {
            startEdit("minute");
            e.currentTarget.select?.();
          }}
          onChange={(e) => typeEdit("minute", e.target.value)}
          onBlur={() => commitEdit("minute")}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-label={t("chronicle.dialMinute", "分")}
          style={readout(mode === "minute")}
        />
      </div>

      <div
        ref={ref}
        data-testid="chronicle-time-dial"
        role="slider"
        tabIndex={0}
        aria-label={
          mode === "hour"
            ? t("chronicle.dialHour", "時")
            : t("chronicle.dialMinute", "分")
        }
        aria-valuemin={0}
        aria-valuemax={mode === "hour" ? 23 : 55}
        aria-valuenow={mode === "hour" ? hour : minute}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKey}
        className="outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{
          position: "relative",
          width: DIAL,
          height: DIAL,
          margin: "0 auto",
          borderRadius: "50%",
          background: "color-mix(in oklch, var(--foreground) 5%, var(--card))",
          border: "1px solid var(--border)",
          touchAction: "none",
          cursor: "pointer",
        }}
      >
        {/* 針（key=mode で時↔分の切替時は再マウント＝アニメさせず瞬間移動。
            同一モード内の値変更時のみ transition で滑らかに動かす） */}
        <div
          key={`hand-${mode}`}
          style={{
            position: "absolute",
            left: CENTER,
            top: CENTER - 1,
            width: hand.r,
            height: 2,
            background: "var(--primary)",
            transformOrigin: "0 50%",
            transform: `rotate(${handAngle}deg)`,
            transition: motion,
            pointerEvents: "none",
          }}
        />
        {/* 選択ノブ */}
        <div
          key={`knob-${mode}`}
          style={{
            position: "absolute",
            left: end.x - 15,
            top: end.y - 15,
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "var(--primary)",
            transition: motion,
            pointerEvents: "none",
          }}
        />
        {/* 中心ドット */}
        <div
          style={{
            position: "absolute",
            left: CENTER - 3,
            top: CENTER - 3,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--primary)",
            pointerEvents: "none",
          }}
        />
        {/* 数字 */}
        {mode === "hour"
          ? [
              ...HOUR_OUTER.map((h, p) => {
                const { x, y } = ptAt(p, R_OUT);
                return num(`o${h}`, x, y, String(h), hour === h, false);
              }),
              ...HOUR_INNER.map((h, p) => {
                const { x, y } = ptAt(p, R_IN);
                return num(`i${h}`, x, y, pad2(h), hour === h, true);
              }),
            ]
          : MINUTES.map((m, i) => {
              const { x, y } = ptAt(i, R_OUT);
              return num(`m${m}`, x, y, pad2(m), minute === m, false);
            })}
      </div>
    </div>
  );
}
