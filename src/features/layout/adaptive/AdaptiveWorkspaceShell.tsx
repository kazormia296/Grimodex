import { useEffect, type ReactNode } from "react";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";
import { useViewportProfile } from "@/runtime/useViewportProfile";
import { installMobileViewportVars } from "@/runtime/mobileViewport";
import { CompactWorkspaceChrome } from "./CompactWorkspaceChrome";
import { PhoneWorkspaceChrome } from "./PhoneWorkspaceChrome";
import { WideWorkspaceChrome } from "./WideWorkspaceChrome";
import { WorkspaceSurfaceRoot } from "./WorkspaceSurfaceRoot";
import { useCompactNavigationStore } from "./compactNavigationStore";

export type MobileWorkspaceSurfaces = Partial<
  Record<"scenes" | "codex" | "ai" | "more", ReactNode>
>;
export type MobileWorkspaceSurfaceId = keyof MobileWorkspaceSurfaces;

interface Props {
  profile?: WorkspaceViewportProfile;
  editor: ReactNode;
  panel?: ReactNode;
  panelOpen?: boolean;
  sceneTitle?: string;
  saveState?: string;
  onBack?: () => void;
  mobileSurfaces?: MobileWorkspaceSurfaces;
  renderMobileSurface?: (surface: MobileWorkspaceSurfaceId) => ReactNode;
}

export function AdaptiveWorkspaceShell({
  profile: requestedProfile,
  editor,
  panel,
  panelOpen = Boolean(panel),
  sceneTitle,
  saveState,
  onBack,
  mobileSurfaces,
  renderMobileSurface,
}: Props) {
  const viewport = useViewportProfile();
  const activeSurface = useCompactNavigationStore(
    (state) => state.activeSurface,
  );
  const profile = requestedProfile ?? viewport.profile;
  const mobileSurfaceId =
    profile === "phone" && activeSurface !== "editor"
      ? (activeSurface as MobileWorkspaceSurfaceId)
      : null;
  const mobileSurface = mobileSurfaceId
    ? (mobileSurfaces?.[mobileSurfaceId] ??
      renderMobileSurface?.(mobileSurfaceId))
    : undefined;
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
  return (
    <div
      ref={requestedProfile === undefined ? viewport.ref : undefined}
      data-adaptive-workspace-shell
      data-profile={profile}
    >
      <WideWorkspaceChrome active={profile === "wide"} />
      <CompactWorkspaceChrome active={profile === "compact"} />
      <PhoneWorkspaceChrome
        active={profile === "phone"}
        sceneTitle={sceneTitle}
        saveState={saveState}
        onBack={onBack}
      />
      <WorkspaceSurfaceRoot
        profile={profile}
        editor={editor}
        panel={panel}
        panelOpen={panelOpen}
        mobileSurface={mobileSurface}
      />
    </div>
  );
}
