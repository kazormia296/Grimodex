import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";

export interface MountedMobileSurface {
  id: string;
  content: ReactNode;
  active: boolean;
}

interface Props {
  profile: WorkspaceViewportProfile;
  editor: ReactNode;
  zenMode?: boolean;
  panel?: ReactNode;
  panelOpen: boolean;
  mobileSurface?: ReactNode;
  mountedMobileSurfaces?: readonly MountedMobileSurface[];
}

function hiddenProps(hidden: boolean): Record<string, unknown> {
  return hidden ? { "aria-hidden": true, inert: true } : {};
}

export function WorkspaceSurfaceRoot({
  profile,
  editor,
  zenMode = false,
  panel,
  panelOpen,
  mobileSurface,
  mountedMobileSurfaces,
}: Props) {
  const surfaces =
    mountedMobileSurfaces ??
    (mobileSurface == null
      ? []
      : [{ id: "active", content: mobileSurface, active: true }]);
  const hasActiveMobileSurface = surfaces.some((surface) => surface.active);
  const activeMobileSurfaceId = surfaces.find((surface) => surface.active)?.id;
  const surfaceRootRef = useRef<HTMLDivElement>(null);
  const previousActiveSurfaceId = useRef<string | undefined>(undefined);
  const editorHidden =
    !zenMode && profile === "phone" && (panelOpen || hasActiveMobileSurface);
  const editorStyle: CSSProperties = editorHidden
    ? { visibility: "hidden", pointerEvents: "none" }
    : { visibility: "visible" };
  const panelVisible = panelOpen && !zenMode;
  const panelStyle: CSSProperties = panelVisible
    ? { visibility: "visible" }
    : { visibility: "hidden", pointerEvents: "none" };

  useEffect(() => {
    const previous = previousActiveSurfaceId.current;
    previousActiveSurfaceId.current = activeMobileSurfaceId;
    if (
      profile !== "phone" ||
      activeMobileSurfaceId === undefined ||
      activeMobileSurfaceId === previous
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      surfaceRootRef.current
        ?.querySelector<HTMLElement>(
          `[data-mobile-surface-id="${activeMobileSurfaceId}"]`,
        )
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeMobileSurfaceId, profile]);

  return (
    <div
      ref={surfaceRootRef}
      data-workspace-surface-root
      data-profile={profile}
    >
      <div
        data-editor-surface
        style={editorStyle}
        {...hiddenProps(editorHidden)}
      >
        {editor}
      </div>
      {panel && (
        <div
          data-active-panel-surface
          style={panelStyle}
          {...hiddenProps(!panelVisible)}
        >
          {panel}
        </div>
      )}
      {surfaces.map((surface) => {
        const visible = profile === "phone" && !zenMode && surface.active;
        return (
          <div
            key={surface.id}
            data-mobile-surface
            data-mobile-surface-id={surface.id}
            tabIndex={-1}
            style={{
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
            {...hiddenProps(!visible)}
          >
            {surface.content}
          </div>
        );
      })}
    </div>
  );
}
