import { useEffect, useRef, type ReactNode } from "react";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { resolvePhoneEditorGroup } from "@/features/editor/phoneEditorGroup";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";
import { useViewportProfile } from "@/runtime/useViewportProfile";
import { installMobileViewportVars } from "@/runtime/mobileViewport";
import { CompactWorkspaceChrome } from "./CompactWorkspaceChrome";
import { PhoneWorkspaceChrome } from "./PhoneWorkspaceChrome";
import { WideWorkspaceChrome } from "./WideWorkspaceChrome";
import { WorkspaceSurfaceRoot } from "./WorkspaceSurfaceRoot";
import { useCompactNavigationStore } from "./compactNavigationStore";

const MOBILE_WORKSPACE_SURFACE_IDS = [
  "scenes",
  "codex",
  "ai",
  "more",
  "search",
] as const;

export type MobileWorkspaceSurfaceId =
  (typeof MOBILE_WORKSPACE_SURFACE_IDS)[number];
export type MobileWorkspaceSurfaces = Partial<
  Record<MobileWorkspaceSurfaceId, ReactNode>
>;

interface Props {
  profile?: WorkspaceViewportProfile;
  editor: ReactNode;
  zenMode?: boolean;
  panel?: ReactNode;
  panelOpen?: boolean;
  onBack?: () => void;
  mobileSurfaces?: MobileWorkspaceSurfaces;
  renderMobileSurface?: (surface: MobileWorkspaceSurfaceId) => ReactNode;
}

export function AdaptiveWorkspaceShell({
  profile: requestedProfile,
  editor,
  zenMode = false,
  panel,
  panelOpen = Boolean(panel),
  onBack,
  mobileSurfaces,
  renderMobileSurface,
}: Props) {
  const viewport = useViewportProfile();
  const activeSurface = useCompactNavigationStore(
    (state) => state.activeSurface,
  );
  const previousSurfaceRef = useRef(activeSurface);
  const profile = requestedProfile ?? viewport.profile;
  const mountedMobileSurfaces =
    profile === "phone"
      ? MOBILE_WORKSPACE_SURFACE_IDS.flatMap((surface) => {
          const content =
            mobileSurfaces?.[surface] ?? renderMobileSurface?.(surface);
          return content == null
            ? []
            : [{ id: surface, content, active: activeSurface === surface }];
        })
      : [];
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined")
      return undefined;
    return installMobileViewportVars(
      window as unknown as Parameters<typeof installMobileViewportVars>[0],
      document.documentElement as unknown as Parameters<
        typeof installMobileViewportVars
      >[1],
    );
  }, []);
  useEffect(() => {
    const previousSurface = previousSurfaceRef.current;
    previousSurfaceRef.current = activeSurface;
    if (
      profile === "phone" &&
      activeSurface === "editor" &&
      previousSurface !== "editor"
    ) {
      const tabs = useTabStore.getState();
      const documentId = useTreeStore.getState().activeSceneId;
      const inlineAi = useInlineAiStore.getState();
      const inlineAiPending =
        inlineAi.status === "generating" ||
        inlineAi.status === "diffShown" ||
        inlineAi.status === "error";
      useEditorSessionStore
        .getState()
        .requestEditorFocus(
          resolvePhoneEditorGroup(
            tabs,
            documentId,
            inlineAiPending ? inlineAi.activeEditorGroup : null,
          ),
        );
    }
  }, [activeSurface, profile]);
  return (
    <div
      ref={requestedProfile === undefined ? viewport.ref : undefined}
      data-adaptive-workspace-shell
      data-profile={profile}
      data-zen-mode={zenMode ? "true" : undefined}
    >
      <WideWorkspaceChrome active={!zenMode && profile === "wide"} />
      <CompactWorkspaceChrome active={!zenMode && profile === "compact"} />
      <PhoneWorkspaceChrome
        active={!zenMode && profile === "phone"}
        onBack={onBack}
      />
      <WorkspaceSurfaceRoot
        profile={profile}
        editor={editor}
        zenMode={zenMode}
        panel={panel}
        panelOpen={panelOpen}
        mountedMobileSurfaces={mountedMobileSurfaces}
      />
    </div>
  );
}
