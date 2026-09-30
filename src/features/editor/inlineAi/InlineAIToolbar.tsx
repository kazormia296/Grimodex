import { Check, X, AlertTriangle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useInlineAiStore } from "./inlineAiStore";
import { DURATIONS, SHAKE_KEYFRAMES, useReducedMotion } from "@/lib/animation";

interface InlineAIToolbarProps {
  onAccept: () => void;
  /**
   * status === "generating" のときはストリーミング中止、
   * status === "diffShown" のときは diff を取り消して元状態に戻す、
   * status === "error" のときは error を破棄して idle に戻す。
   */
  onReject: () => void;
  onRetry: () => void;
  /**
   * 追従先 = owner エディタの本文スクロールコンテナ。この要素の下端中央に
   * ツールバーを `position: fixed` で配置する (画面下部中央ではなくエディタ
   * 下部中央に出すことで、下 Stripe にツールがあっても本文との対応が分かる)。
   */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * この呼び出し側エディタが現在の pending セッションの所有者か。分割ビューで
   * 両ペインが同じツールバーを二重表示しないよう、owner だけ表示する。
   */
  isOwner: boolean;
}

/**
 * anchor 要素の下端中央に張り付く `position: fixed` 座標を計算する。scroll /
 * resize で rAF 追従する。`active` が false の間はリスナを張らず style=null。
 */
function useBottomCenterStyle(
  anchorRef: RefObject<HTMLElement | null>,
  active: boolean,
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setStyle(null);
      return;
    }
    let raf = 0;
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setStyle({
        position: "fixed",
        left: r.left + r.width / 2,
        // anchor 下端の 12px 上に置く。anchor がビューポート外まで伸びる
        // (リニアの長いシーン等) 場合は画面下部 8px に clamp する。
        bottom: Math.max(8, window.innerHeight - r.bottom + 12),
        zIndex: 50,
      });
    };
    const onScrollResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }, [anchorRef, active]);
  return style;
}

/**
 * Floating toolbar shown when an Inline AI session is active for the owning
 * editor. Accept (Tab) / Reject (Esc) / Retry. error 状態でも表示して、未保存の
 * 部分生成テキストを Reject(=dismiss) / Retry で解消できる出口を残す。
 */
export function InlineAIToolbar({
  onAccept,
  onReject,
  onRetry,
  anchorRef,
  isOwner,
}: InlineAIToolbarProps) {
  const { t } = useTranslation();
  const status = useInlineAiStore((s) => s.status);
  const attentionNonce = useInlineAiStore((s) => s.attentionNonce);
  const reduced = useReducedMotion();

  const isPending =
    status === "generating" || status === "diffShown" || status === "error";
  const isVisible = isPending && isOwner;

  const style = useBottomCenterStyle(anchorRef, isVisible);

  // Tab = accept (diffShown のみ), Esc = reject/abort/dismiss
  useEffect(() => {
    if (!isVisible) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Tab" && status === "diffShown") {
        e.preventDefault();
        onAccept();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onReject();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [isVisible, status, onAccept, onReject]);

  // 離脱系操作がブロックされたとき (attentionNonce++) に一瞬揺らす。
  const [shaking, setShaking] = useState(false);
  const prevNonce = useRef(attentionNonce);
  useEffect(() => {
    if (attentionNonce === prevNonce.current) return;
    prevNonce.current = attentionNonce;
    if (reduced) return;
    setShaking(true);
    const id = setTimeout(() => setShaking(false), DURATIONS.slow * 1000 + 80);
    return () => clearTimeout(id);
  }, [attentionNonce, reduced]);

  if (!isVisible || !style) return null;

  const isGenerating = status === "generating";
  const isError = status === "error";
  const canAccept = status === "diffShown";

  return createPortal(
    <div style={style} className="-translate-x-1/2">
      <motion.div
        animate={shaking ? { x: SHAKE_KEYFRAMES } : { x: 0 }}
        transition={{ duration: DURATIONS.slow }}
        className="flex items-center gap-1 rounded-full border border-border bg-popover px-3 py-1.5 shadow-lg"
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          disabled={!canAccept}
          onClick={onAccept}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-green-600 hover:bg-green-50 disabled:opacity-40 dark:hover:bg-green-950"
        >
          <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
          {t("inlineAi.accept")}
          {canAccept && (
            <kbd className="ml-0.5 rounded border border-border px-1 text-xs text-muted-foreground">
              Tab
            </kbd>
          )}
        </button>
        <div aria-hidden className="h-3 w-px bg-border" />
        <button
          type="button"
          onClick={onReject}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
        >
          <X className="h-3 w-3" aria-hidden />
          {t("inlineAi.reject")}
          <kbd className="ml-0.5 rounded border border-border px-1 text-xs text-muted-foreground">
            Esc
          </kbd>
        </button>
        {!isGenerating && (
          <>
            <div aria-hidden className="h-3 w-px bg-border" />
            <button
              type="button"
              onClick={onRetry}
              className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              ↺ {t("common.retry")}
            </button>
          </>
        )}
        {isGenerating && (
          <span className="ml-1 text-xs text-muted-foreground animate-pulse">
            {t("aiTree.generating")}
          </span>
        )}
        {isError && (
          <span className="ml-1 flex items-center gap-1 text-xs text-red-500">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t("inlineAi.generateFailed")}
          </span>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}
