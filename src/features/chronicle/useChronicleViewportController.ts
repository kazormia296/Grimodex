import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { announce } from "@/lib/a11y/announcer";
import { fitAll, zoomByCenter, type View } from "./chronicleAxis";
import { useChronicleStore } from "./chronicleStore";

interface UseChronicleViewportControllerOptions {
  dataStart: number;
  dataEnd: number;
  eventCount: number;
  focusDay: number;
}

export function useChronicleViewportController({
  dataStart,
  dataEnd,
  eventCount,
  focusDay,
}: UseChronicleViewportControllerOptions) {
  const { t } = useTranslation();
  const setChronicleView = useChronicleStore((s) => s.setChronicleView);
  const [view, setView] = useState<View>(() => {
    const state = useChronicleStore.getState();
    return state.pxPerDay != null && state.viewStartDay != null
      ? { pxPerDay: state.pxPerDay, viewStartDay: state.viewStartDay }
      : { pxPerDay: 1, viewStartDay: 0 };
  });
  const [trackW, setTrackW] = useState(0);
  const trackElRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef(useChronicleStore.getState().pxPerDay != null);
  const rulerLevelRef = useRef("day");
  const zoomAnnounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastPxPerDayRef = useRef(view.pxPerDay);

  const scheduleZoomAnnounce = useCallback(() => {
    if (zoomAnnounceTimerRef.current) {
      clearTimeout(zoomAnnounceTimerRef.current);
    }
    zoomAnnounceTimerRef.current = setTimeout(() => {
      zoomAnnounceTimerRef.current = null;
      const level = rulerLevelRef.current;
      const unit =
        level === "year"
          ? t("chronicle.year", "年")
          : level === "month"
            ? t("chronicle.month", "月")
            : level === "day"
              ? t("chronicle.day", "日")
              : level === "hour"
                ? t("chronicle.dialHour", "時")
                : level === "minute"
                  ? t("chronicle.dialMinute", "分")
                  : t("chronicle.readingOrder", "読む順");
      announce(t("chronicle.a11yZoomLevel", "ズーム: {{unit}}単位", { unit }));
    }, 400);
  }, [t]);

  useEffect(
    () => () => {
      if (zoomAnnounceTimerRef.current) {
        clearTimeout(zoomAnnounceTimerRef.current);
      }
    },
    [],
  );

  const applyView = useCallback(
    (nextView: View) => {
      if (nextView.pxPerDay !== lastPxPerDayRef.current) {
        lastPxPerDayRef.current = nextView.pxPerDay;
        scheduleZoomAnnounce();
      }
      setView(nextView);
      setChronicleView(nextView.pxPerDay, nextView.viewStartDay);
    },
    [scheduleZoomAnnounce, setChronicleView],
  );

  const resetForProject = useCallback((projectId: string | null) => {
    fittedRef.current = projectId
      ? useChronicleStore.getState().pxPerDay != null
      : false;
  }, []);

  useEffect(() => {
    if (trackW > 0 && !fittedRef.current && eventCount > 0) {
      fittedRef.current = true;
      setView(
        fitAll({
          dataStart,
          dataEnd,
          trackW,
          focusDay,
        }),
      );
    }
  }, [trackW, eventCount, dataStart, dataEnd, focusDay]);

  const fit = useCallback(() => {
    const liveW = trackElRef.current?.clientWidth || trackW;
    applyView(
      fitAll({
        dataStart,
        dataEnd,
        trackW: liveW,
        focusDay,
      }),
    );
  }, [applyView, dataStart, dataEnd, focusDay, trackW]);

  const zoom = useCallback(
    (factor: number) => applyView(zoomByCenter({ view, trackW, factor })),
    [applyView, trackW, view],
  );

  const centerOnDay = useCallback(
    (day: number) => {
      if (view.pxPerDay <= 0 || trackW <= 0) return;
      applyView({
        pxPerDay: view.pxPerDay,
        viewStartDay: day - trackW / 2 / view.pxPerDay,
      });
    },
    [applyView, trackW, view],
  );

  return {
    view,
    trackW,
    trackElRef,
    rulerLevelRef,
    setTrackW,
    setRulerLevel: (level: string) => {
      rulerLevelRef.current = level;
    },
    applyView,
    resetForProject,
    fit,
    zoom,
    centerOnDay,
  };
}
