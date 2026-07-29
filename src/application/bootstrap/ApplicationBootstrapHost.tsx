import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  StrictQuiescenceError,
  flushStrictQuiescence,
  type QuiescenceFailure,
} from "@/application/lifecycle/quiescenceCoordinator";
import {
  createCloseQuiescenceController,
  type CloseQuiescenceController,
} from "@/application/lifecycle/closeQuiescenceController";
import { discardAllRegisteredEditorDrafts } from "@/features/editor/editorSaveRegistry";
import {
  consumeWebEditorHandoffRequest,
  subscribeWebEditorHandoffRequests,
} from "@/features/import/webEditorHandoffRequest";
import { useLicenseStateListener } from "@/features/license/useLicenseStateListener";
import { useExternalMountListener } from "@/features/external-mount/useExternalMountListener";
import { ensureSemanticIndexesOnOpen } from "@/features/semantic-search/autoIndex";
import { subscribeSemanticRetryAfterLifecycle } from "@/features/semantic-search/semanticLifecycle";
import { useModelDownloadListener } from "@/features/semantic-search/useModelDownloadListener";
import { useReindexProgressListener } from "@/features/semantic-search/useReindexProgressListener";
import { useReleaseNotesGate } from "@/features/release-notes/useReleaseNotesGate";
import { useUpdateChecker } from "@/features/updater/useUpdateChecker";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useTabStore } from "@/features/editor/tabStore";
import {
  createEditorInputScopeKey,
  waitForForegroundEditorInputReady,
} from "@/features/editor/editorInputReady";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useSyncUiScale } from "@/features/workspace/useSyncUiScale";
import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import { debugLog, useDebugLogStore } from "@/lib/debugLog";
import {
  isInlineAiPending,
  guardInlineAiPending,
} from "@/features/editor/inlineAi/pendingGuard";
import { matchesMod } from "@/lib/platform";
import { closeWindow, onWindowCloseRequested } from "@/lib/windowControls";
import { exportRecoveryDrafts } from "@/application/lifecycle/exportRecoveryDrafts";
import { discardQuiescenceParticipants } from "@/application/lifecycle/quiescenceParticipants";
import { discardQuiescenceProviders } from "@/lib/quiescenceProviders";
import { hasUnresolvedEditorChanges } from "@/lib/editorQuiescence";
import { useTranslation } from "react-i18next";
import i18next from "@/lib/i18n";
import { applyApplicationTheme } from "./applicationTheme";

export function ApplicationBootstrapHost({
  onWebEditorImportRequested,
  renderCloseFailureDialog,
  runtimeCapabilities,
}: {
  onWebEditorImportRequested: () => void;
  runtimeCapabilities: RuntimeCapabilities;
  renderCloseFailureDialog: (props: {
    open: boolean;
    onCancel: () => void;
    onRetry: () => void;
    onExport: () => void;
    onDiscard: () => void;
  }) => ReactNode;
}) {
  const activeWorkspacePath = useWorkspaceStore(
    (state) => state.activeWorkspacePath,
  );
  const workspaceOpenRevision = useWorkspaceStore(
    (state) => state.workspaceOpenRevision,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (state) => state.workspaceSwitchInProgress,
  );
  const workspaceHydrated = useWorkspaceStore(
    (state) => state.workspaceHydrated,
  );
  const initialize = useWorkspaceStore((state) => state.initialize);
  const theme = useWorkspaceStore(
    (state) => state.globalSettings?.theme ?? "system",
  );
  const colorTheme = useWorkspaceStore(
    (state) => state.globalSettings?.colorTheme,
  );
  const uiLanguage = useWorkspaceStore(
    (state) => state.globalSettings?.uiLanguage ?? "ja",
  );
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const tabStateHydrated = useTabStore((state) => state.tabStateHydrated);
  const attributionOpacity = useSettingsStore((state) =>
    state.getNumber("display.attributionHighlightOpacity", 10),
  );
  const uiFontFamily = useSettingsStore((state) =>
    state.get("display.uiFontFamily"),
  );
  const toggleDebugLog = useDebugLogStore((state) => state.toggle);
  const { t } = useTranslation();
  const [closeFailures, setCloseFailures] = useState<
    readonly QuiescenceFailure[] | null
  >(null);
  const [quiescenceSettledRevision, setQuiescenceSettledRevision] = useState(0);
  const closeControllerRef = useRef<CloseQuiescenceController | null>(null);

  useEffect(
    () =>
      subscribeSemanticRetryAfterLifecycle(() => {
        setQuiescenceSettledRevision((revision) => revision + 1);
      }),
    [],
  );

  useEffect(
    () =>
      subscribeWebEditorHandoffRequests(() => {
        if (consumeWebEditorHandoffRequest()) onWebEditorImportRequested();
      }),
    [onWebEditorImportRequested],
  );

  useReindexProgressListener();
  useModelDownloadListener();
  useUpdateChecker();
  useReleaseNotesGate();
  useExternalMountListener();
  useLicenseStateListener();

  const foregroundEditorScopeKey = createEditorInputScopeKey({
    projectId: currentProjectId,
    workspacePath: activeWorkspacePath,
    workspaceOpenRevision,
  });
  useEffect(() => {
    if (
      runtimeCapabilities.localAi &&
      workspaceHydrated &&
      !workspaceSwitchInProgress &&
      tabStateHydrated &&
      currentProjectId &&
      activeWorkspacePath
    ) {
      const controller = new AbortController();
      void waitForForegroundEditorInputReady({
        signal: controller.signal,
        expectedProjection: {
          authorities: ["workspace", "linear"],
          scopeKey: foregroundEditorScopeKey,
        },
      }).then((editorReady) => {
        if (controller.signal.aborted) return;
        if (!editorReady) {
          debugLog.warn(
            "semantic-search",
            "foreground Editor readiness timed out; starting background indexing",
          );
        }
        void ensureSemanticIndexesOnOpen(currentProjectId, activeWorkspacePath);
      });
      return () => controller.abort();
    }
    return undefined;
  }, [
    activeWorkspacePath,
    currentProjectId,
    foregroundEditorScopeKey,
    tabStateHydrated,
    workspaceHydrated,
    workspaceOpenRevision,
    workspaceSwitchInProgress,
    quiescenceSettledRevision,
    runtimeCapabilities.localAi,
  ]);

  useEffect(() => {
    if (i18next.language !== uiLanguage)
      void i18next.changeLanguage(uiLanguage);
  }, [uiLanguage]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const controller = createCloseQuiescenceController({
          hasImmediateVeto: guardInlineAiPending,
          flush: flushStrictQuiescence,
          close: closeWindow,
          onFailure: (error) => {
            setCloseFailures(
              error instanceof StrictQuiescenceError
                ? error.failures
                : [{ stage: "participants", error }],
            );
          },
        });
        closeControllerRef.current = controller;
        const un = await onWindowCloseRequested(controller.handleCloseRequest);
        if (disposed) un();
        else unlisten = un;
      } catch {
        // Non-native runtimes use beforeunload below.
      }
    })();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isInlineAiPending() || hasUnresolvedEditorChanges()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      disposed = true;
      closeControllerRef.current?.cancel();
      closeControllerRef.current = null;
      unlisten?.();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  useEffect(
    () => applyApplicationTheme(theme, colorTheme),
    [theme, colorTheme],
  );

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyApplicationTheme("system", colorTheme);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme, colorTheme]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--attribution-pct",
      `${attributionOpacity * 2}%`,
    );
  }, [attributionOpacity]);

  useEffect(() => {
    const html = document.documentElement;
    const value = uiFontFamily.trim();
    if (value) html.style.setProperty("--ui-font", value);
    else html.style.removeProperty("--ui-font");
  }, [uiFontFamily]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useSyncUiScale();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        matchesMod(event) &&
        event.shiftKey &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        toggleDebugLog();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleDebugLog]);

  return renderCloseFailureDialog({
    open: closeFailures !== null,
    onCancel: () => {
      closeControllerRef.current?.cancel();
      setCloseFailures(null);
    },
    onRetry: () => {
      setCloseFailures(null);
      closeControllerRef.current?.retry();
    },
    onExport: () => {
      if (!closeFailures) return;
      void exportRecoveryDrafts(closeFailures).catch(() => {
        toast.error(t("closeSaveFailure.exportFailed"));
      });
    },
    onDiscard: () => {
      discardQuiescenceProviders();
      discardQuiescenceParticipants();
      discardAllRegisteredEditorDrafts();
      setCloseFailures(null);
      closeControllerRef.current?.discardAndClose();
    },
  });
}
