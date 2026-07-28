import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { announce } from "@/lib/a11y/announcer";
import { fitAll, zoomByCenter, type View } from "./chronicleAxis";
import { useChronicleStore, type ChronicleAxisMode } from "./chronicleStore";

interface UseChronicleViewportControllerOptions {
  workspacePath: string | null;
  projectId: string | null;
  dataReady: boolean;
  dataStart: number;
  dataEnd: number;
  eventCount: number;
  focusDay: number;
  hasCalendarAxis: boolean;
}

function persistedViewState(): {
  view: View;
  axisMode: ChronicleAxisMode | null;
  viewProjectId: string | null;
  viewWorkspacePath: string | null;
} | null {
  const state = useChronicleStore.getState();
  return state.pxPerDay != null && state.viewStartDay != null
    ? {
        view: {
          pxPerDay: state.pxPerDay,
          viewStartDay: state.viewStartDay,
        },
        axisMode: state.axisMode,
        viewProjectId: state.viewProjectId,
        viewWorkspacePath: state.viewWorkspacePath,
      }
    : null;
}

export function useChronicleViewportController({
  workspacePath,
  projectId,
  dataReady,
  dataStart,
  dataEnd,
  eventCount,
  focusDay,
  hasCalendarAxis,
}: UseChronicleViewportControllerOptions) {
  const { t } = useTranslation();
  const setChronicleView = useChronicleStore((s) => s.setChronicleView);
  const currentAxisMode: ChronicleAxisMode = hasCalendarAxis
    ? "calendar"
    : "sequence";
  const [view, setView] = useState<View>(() => {
    return persistedViewState()?.view ?? { pxPerDay: 1, viewStartDay: 0 };
  });
  const [trackW, setTrackW] = useState(0);
  const trackElRef = useRef<HTMLDivElement | null>(null);
  const initialPersistedView = persistedViewState();
  const fittedRef = useRef(initialPersistedView !== null);
  const displayedAxisModeRef = useRef<ChronicleAxisMode | null>(
    initialPersistedView?.axisMode ?? null,
  );
  const displayedProjectIdRef = useRef<string | null>(
    initialPersistedView?.viewProjectId ?? null,
  );
  const displayedWorkspacePathRef = useRef<string | null>(
    initialPersistedView?.viewWorkspacePath ?? null,
  );
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
      // Project 切替中の scene-only projection で pan/zoom を保存すると、
      // 後着する実 Event に対する初回 fit が抑止されるため操作を受け付けない。
      if (!dataReady || !projectId || !workspacePath) return;
      if (nextView.pxPerDay !== lastPxPerDayRef.current) {
        lastPxPerDayRef.current = nextView.pxPerDay;
        scheduleZoomAnnounce();
      }
      setView(nextView);
      fittedRef.current = true;
      displayedAxisModeRef.current = currentAxisMode;
      displayedProjectIdRef.current = projectId;
      displayedWorkspacePathRef.current = workspacePath;
      if (projectId && workspacePath) {
        setChronicleView(
          nextView.pxPerDay,
          nextView.viewStartDay,
          currentAxisMode,
          projectId,
          workspacePath,
        );
      }
    },
    [
      currentAxisMode,
      dataReady,
      projectId,
      scheduleZoomAnnounce,
      setChronicleView,
      workspacePath,
    ],
  );

  const resetForProject = useCallback((nextProjectId: string | null) => {
    const persisted = nextProjectId ? persistedViewState() : null;
    fittedRef.current = persisted !== null;
    displayedAxisModeRef.current = persisted?.axisMode ?? null;
    displayedProjectIdRef.current = persisted?.viewProjectId ?? null;
    displayedWorkspacePathRef.current = persisted?.viewWorkspacePath ?? null;
    if (persisted) {
      lastPxPerDayRef.current = persisted.view.pxPerDay;
      setView(persisted.view);
    }
  }, []);

  useEffect(() => {
    if (
      !dataReady ||
      !workspacePath ||
      !projectId ||
      trackW <= 0 ||
      eventCount <= 0
    )
      return;

    const persisted = persistedViewState();
    const initialFit = !fittedRef.current;
    const persistedModeNeedsMigration =
      persisted !== null && persisted.axisMode !== currentAxisMode;
    const persistedProjectNeedsMigration =
      persisted !== null && persisted.viewProjectId !== projectId;
    const persistedWorkspaceNeedsMigration =
      persisted !== null && persisted.viewWorkspacePath !== workspacePath;
    const sessionModeChanged =
      persisted === null &&
      displayedAxisModeRef.current !== null &&
      displayedAxisModeRef.current !== currentAxisMode;
    const sessionProjectChanged =
      persisted === null &&
      displayedProjectIdRef.current !== null &&
      displayedProjectIdRef.current !== projectId;
    const sessionWorkspaceChanged =
      persisted === null &&
      displayedWorkspacePathRef.current !== null &&
      displayedWorkspacePathRef.current !== workspacePath;
    if (
      !initialFit &&
      !persistedModeNeedsMigration &&
      !sessionModeChanged &&
      !persistedProjectNeedsMigration &&
      !sessionProjectChanged &&
      !persistedWorkspaceNeedsMigration &&
      !sessionWorkspaceChanged
    ) {
      // 同じ Project / 座標モード内の dataStart/dataEnd 変化では user view を
      // 保持する。データ外への pan も意図的なナビゲーションとして尊重する。
      displayedAxisModeRef.current = currentAxisMode;
      displayedProjectIdRef.current = projectId;
      displayedWorkspacePathRef.current = workspacePath;
      return;
    }

    const nextView = fitAll({
      dataStart,
      dataEnd,
      trackW,
      focusDay,
    });
    fittedRef.current = true;
    displayedAxisModeRef.current = currentAxisMode;
    displayedProjectIdRef.current = projectId;
    displayedWorkspacePathRef.current = workspacePath;
    lastPxPerDayRef.current = nextView.pxPerDay;
    setView(nextView);

    // legacy / 別 mode / 別 Project 所有の persisted view は一度だけ現在の
    // Project / mode へ移行して保存する。永続値が無い初回/session遷移の fit は
    // ローカルのみ。
    if (
      persistedModeNeedsMigration ||
      persistedProjectNeedsMigration ||
      persistedWorkspaceNeedsMigration
    ) {
      setChronicleView(
        nextView.pxPerDay,
        nextView.viewStartDay,
        currentAxisMode,
        projectId,
        workspacePath,
      );
    }
  }, [
    currentAxisMode,
    dataReady,
    dataEnd,
    dataStart,
    eventCount,
    focusDay,
    projectId,
    setChronicleView,
    trackW,
    workspacePath,
  ]);

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
