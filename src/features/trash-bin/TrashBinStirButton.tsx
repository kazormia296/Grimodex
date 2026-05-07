import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tornado } from "lucide-react";

interface Props {
  /** 単発タップで呼ばれる (1 回のインパルス)。 */
  onStir: (intensity: number) => void;
  /** disabled (空のとき) */
  disabled?: boolean;
}

const SHORT_TAP_INTENSITY = 400; // STIR_IMPULSE
const MAX_INTENSITY = 1200; // STIR_IMPULSE_MAX
const HOLD_INTERVAL_MS = 300;
const HOLD_RAMP_MS = 1500; // 1.5 秒で max に到達

/**
 * 設計書 §7 / §8.3 のかき混ぜるボタン。
 *  - 単発タップ (短押し離す): 1 回 applyShake(400)
 *  - 長押し: 300ms 間隔で applyShake、強度を線形に MAX_INTENSITY まで上げる
 */
export function TrashBinStirButton({ onStir, disabled }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const holdStartRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    holdStartRef.current = null;
    setActive(false);
  }, []);

  const startHold = useCallback(() => {
    if (disabled) return;
    setActive(true);
    holdStartRef.current = performance.now();
    intervalRef.current = setInterval(() => {
      const start = holdStartRef.current;
      if (start === null) return;
      const elapsed = performance.now() - start;
      const ratio = Math.min(1, elapsed / HOLD_RAMP_MS);
      const intensity =
        SHORT_TAP_INTENSITY + (MAX_INTENSITY - SHORT_TAP_INTENSITY) * ratio;
      onStir(intensity);
    }, HOLD_INTERVAL_MS);
  }, [disabled, onStir]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      // 単発タップ用の即時 1 回
      onStir(SHORT_TAP_INTENSITY);
      startHold();
    },
    [onStir, startHold],
  );

  useEffect(() => () => stop(), [stop]);

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      className={`flex items-center gap-1 rounded p-1 text-xs transition-colors ${
        active
          ? "bg-amber-200/60 text-amber-700 dark:bg-amber-700/30 dark:text-amber-200"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      } disabled:opacity-30`}
      title={t("trashBin.stir")}
      aria-label={t("trashBin.stir")}
    >
      <Tornado
        className={`h-3.5 w-3.5 ${active ? "animate-spin" : ""}`}
        aria-hidden
      />
    </button>
  );
}
