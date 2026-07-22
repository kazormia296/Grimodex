import type { CSSProperties, ReactNode } from "react";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";

interface Props {
  profile: WorkspaceViewportProfile;
  editor: ReactNode;
  zenMode?: boolean;
  panel?: ReactNode;
  panelOpen: boolean;
  mobileSurface?: ReactNode;
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
}: Props) {
  const editorHidden =
    !zenMode && profile === "phone" && (panelOpen || mobileSurface != null);
  const editorStyle: CSSProperties = editorHidden
    ? { visibility: "hidden", pointerEvents: "none" }
    : { visibility: "visible" };
  const panelVisible = panelOpen && !zenMode;
  const panelStyle: CSSProperties = panelVisible
    ? { visibility: "visible" }
    : { visibility: "hidden", pointerEvents: "none" };
  const mobileSurfaceVisible = profile === "phone" && !zenMode;

  return (
    <div data-workspace-surface-root data-profile={profile}>
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
      {mobileSurface != null && (
        <div
          data-mobile-surface
          style={{
            visibility: mobileSurfaceVisible ? "visible" : "hidden",
            pointerEvents: mobileSurfaceVisible ? "auto" : "none",
          }}
          {...hiddenProps(!mobileSurfaceVisible)}
        >
          {mobileSurface}
        </div>
      )}
    </div>
  );
}
