import type { CSSProperties, ReactNode } from "react";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";

interface Props {
  profile: WorkspaceViewportProfile;
  editor: ReactNode;
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
  panel,
  panelOpen,
  mobileSurface,
}: Props) {
  const editorHidden =
    profile === "phone" && (panelOpen || mobileSurface != null);
  const editorStyle: CSSProperties = editorHidden
    ? { visibility: "hidden", pointerEvents: "none" }
    : { visibility: "visible" };
  const panelStyle: CSSProperties = panelOpen
    ? { visibility: "visible" }
    : { visibility: "hidden", pointerEvents: "none" };

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
          {...hiddenProps(!panelOpen)}
        >
          {panel}
        </div>
      )}
      {mobileSurface != null && (
        <div
          data-mobile-surface
          style={{
            visibility: profile === "phone" ? "visible" : "hidden",
            pointerEvents: profile === "phone" ? "auto" : "none",
          }}
          {...hiddenProps(profile !== "phone")}
        >
          {mobileSurface}
        </div>
      )}
    </div>
  );
}
