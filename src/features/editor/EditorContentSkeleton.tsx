import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const LINE_WIDTHS = [100, 96, 88, 72, 94, 68, 90, 55] as const;

interface EditorContentSkeletonProps {
  className?: string;
  lineHeight?: number;
  /**
   * 読み込みの表示ではない写し（読み終えた後のフェードアウト用）。aria と
   * testid を持たず、遅れずにすぐ見える。
   */
  decorative?: boolean;
}

/**
 * 速い読み込みでは線を見せない（チラつき防止。PanelLoadingSkeleton と同じ
 * 遅れ）。要素（aria-busy と testid）はすぐに置き、見た目だけを遅らせる。
 */
const LINES_DELAY_S = 0.12;

export function EditorContentSkeleton({
  className,
  lineHeight = 1.8,
  decorative = false,
}: EditorContentSkeletonProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={cn("space-y-3 py-1", className)}
      aria-busy={decorative ? undefined : "true"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : t("editor.loadingContent")}
      data-testid={decorative ? undefined : "editor-content-loading"}
      initial={decorative || reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        delay: LINES_DELAY_S,
        duration: DURATIONS.normal,
        ease: EASINGS.easeOut,
      }}
    >
      {LINE_WIDTHS.map((width, index) => (
        <Skeleton
          key={index}
          className="h-[1em] rounded-sm"
          style={{ width: `${width}%`, lineHeight }}
        />
      ))}
    </motion.div>
  );
}

interface EditorBodyWithLoadingProps {
  isLoading: boolean;
  children: React.ReactNode;
}

/**
 * Covers editor body with a skeleton while scene content is loading.
 *
 * 読み終えたら、読み込みの表示（testid と aria-busy）はすぐに外す（E2E と
 * smoke はその detach を待つ）。線が見えていた（LINES_DELAY_S を過ぎた）ときだけ、
 * aria-hidden の写しを DURATIONS.fast でフェードアウトして本文を見せる。線が
 * 出る前に読み終えたら、本文はすぐに出す（場面の切替そのものは動かさない）。
 */
export function EditorBodyWithLoading({
  isLoading,
  children,
}: EditorBodyWithLoadingProps) {
  const reduced = useReducedMotion();
  const [fading, setFading] = useState(false);
  const loadStartedAtRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (isLoading) {
      loadStartedAtRef.current ??= performance.now();
      setFading(false);
      return;
    }
    const startedAt = loadStartedAtRef.current;
    loadStartedAtRef.current = null;
    if (startedAt === null || reduced) return;
    if (performance.now() - startedAt >= LINES_DELAY_S * 1000) {
      setFading(true);
    }
  }, [isLoading, reduced]);

  return (
    <div className="relative">
      {isLoading && (
        <div className="absolute inset-0 z-10 bg-content-background">
          <EditorContentSkeleton />
        </div>
      )}
      {!isLoading && fading && (
        <motion.div
          aria-hidden
          data-editor-loading-fade
          className="pointer-events-none absolute inset-0 z-10 bg-content-background"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: DURATIONS.fast, ease: EASINGS.easeOut }}
          onAnimationComplete={() => setFading(false)}
        >
          <EditorContentSkeleton decorative />
        </motion.div>
      )}
      <div className={cn(isLoading && "invisible")}>{children}</div>
    </div>
  );
}
