import { useTranslation } from "react-i18next";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";
import {
  EASINGS,
  useReducedMotion,
  WORK_LAYER_DURATIONS,
} from "@/lib/animation";

import { useWorkLayer } from "./WorkLayerContext";

export function WorkPulse() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

  if (workLayer == null) return null;

  const { model, navigation, openAttention, openFocus, openSystem } = workLayer;
  const attentionCount = model.attention.length;
  const attentionDelta = model.attentionDelta ?? 0;
  const resolutionDelta = navigation.mode === "resolved" ? -1 : 0;
  const showArrivalMotion = attentionDelta > 0 && !reducedMotion;
  const showResolutionMotion = resolutionDelta < 0 && !reducedMotion;
  const visibleAttentionCount = attentionCount;
  const focusTitle = model.focus?.title ?? t("workLayer.focus.unset", "未設定");
  const attentionActive =
    attentionCount > 0 &&
    ![
      "ambient",
      "tray-focus",
      "system-activity",
      "system-blocked",
      "resolved",
    ].includes(navigation.mode);
  const focusActive = navigation.mode === "tray-focus";
  const systemActive =
    navigation.mode === "system-activity" ||
    navigation.mode === "system-blocked";
  const systemContent = (
    <>
      <span className="text-[9px] tracking-[0.14em] opacity-60">SYS</span>
      <span className="text-[9px] leading-none">
        {model.system.state === "blocked"
          ? "■ BLOCKED"
          : model.system.state === "running"
            ? `◐ ${model.system.label.toUpperCase()}`
            : "○"}
      </span>
    </>
  );
  return (
    <div
      data-testid="work-pulse"
      data-work-layer-mode={navigation.mode}
      className="inline-flex h-7 max-w-full items-stretch overflow-hidden rounded-sm border border-foreground/30 bg-background font-mono text-foreground shadow-sm"
    >
      <button
        type="button"
        aria-label={t("workLayer.focus.aria", "Focus {{title}}", {
          title: focusTitle,
        })}
        onClick={openFocus}
        className={cn(
          "flex min-w-0 items-center gap-1.5 px-2.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          focusActive && "bg-foreground text-background hover:bg-foreground",
        )}
      >
        <span className="text-[9px] tracking-[0.14em] opacity-60">FOCUS</span>
        <span className="max-w-36 truncate font-sans text-[11px] font-medium">
          {model.focus?.title ?? "—"}
        </span>
      </button>
      <span className="w-px bg-foreground/30" aria-hidden="true" />
      <motion.button
        type="button"
        aria-label={t("workLayer.attention.aria", "Attention {{count}}件", {
          count: visibleAttentionCount,
        })}
        onClick={openAttention}
        data-work-layer-resolution-beat={
          showResolutionMotion ? "true" : undefined
        }
        animate={
          showResolutionMotion
            ? { opacity: [1, 0.72, 1], scale: [1, 0.985, 1] }
            : undefined
        }
        transition={
          showResolutionMotion
            ? {
                duration: WORK_LAYER_DURATIONS.resolution,
                ease: EASINGS.easeOut,
              }
            : undefined
        }
        className={cn(
          "relative flex origin-center items-center gap-1.5 px-2.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          attentionCount === 0 && "text-muted-foreground",
          attentionActive &&
            "bg-foreground text-background hover:bg-foreground",
        )}
      >
        {showArrivalMotion && (
          <motion.span
            aria-hidden="true"
            data-testid="work-layer-arrival-charge"
            className="absolute inset-x-0 bottom-0 h-px origin-left bg-current"
            initial={{ opacity: 0, scaleX: 0 }}
            animate={{ opacity: [0, 1, 0], scaleX: [0, 1, 1] }}
            transition={{
              duration: WORK_LAYER_DURATIONS.arrival,
              ease: EASINGS.easeOut,
            }}
          />
        )}
        <span className="text-[9px] tracking-[0.14em] opacity-60">ATTN</span>
        <span className="relative text-xs font-bold tabular-nums">
          {visibleAttentionCount}
          {showArrivalMotion && (
            <motion.span
              key={`${model.scopeId}-${attentionDelta}`}
              aria-hidden="true"
              className="absolute -right-5 -top-2 text-[8px]"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: [0, 1, 0], y: [4, 0, -4] }}
              transition={{
                duration: WORK_LAYER_DURATIONS.arrival,
                ease: EASINGS.easeOut,
              }}
            >
              +{attentionDelta}
            </motion.span>
          )}
          {showResolutionMotion && (
            <motion.span
              aria-hidden="true"
              className="absolute -right-9 -top-2 whitespace-nowrap text-[8px]"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: [0, 1, 0], y: [-4, 0, 4] }}
              transition={{
                duration: WORK_LAYER_DURATIONS.resolution,
                ease: EASINGS.easeOut,
              }}
            >
              ✓ −{Math.abs(resolutionDelta)}
            </motion.span>
          )}
        </span>
      </motion.button>
      <span className="w-px bg-foreground/30" aria-hidden="true" />
      {model.system.state === "idle" ? (
        <div
          aria-label={t("workLayer.system.aria", "System {{label}}", {
            label: model.system.label,
          })}
          className="flex items-center gap-1.5 px-2.5"
        >
          {systemContent}
        </div>
      ) : (
        <button
          id="work-layer-system-pulse"
          type="button"
          aria-label={t("workLayer.system.aria", "System {{label}}", {
            label: model.system.label,
          })}
          onClick={openSystem}
          className={cn(
            "flex items-center gap-1.5 px-2.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            model.system.state === "blocked" &&
              "border-b-2 border-foreground font-bold",
            (model.system.state === "running" || systemActive) && "bg-accent",
          )}
        >
          {systemContent}
        </button>
      )}
    </div>
  );
}
