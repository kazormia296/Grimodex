import type { ReactNode } from "react";

import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { WorkLayerProvider } from "@/features/work-layer/WorkLayer";
import { useWorkLayerPreviewPort } from "@/features/work-layer/useWorkLayerPreviewPort";

interface EditorWorkspaceProvidersProps {
  readonly activeWorkLayer: boolean;
  readonly children: ReactNode;
  readonly profile: WorkspaceViewportProfile;
}

export function EditorWorkspaceProviders({
  activeWorkLayer,
  children,
  profile,
}: EditorWorkspaceProvidersProps) {
  const workLayerPort = useWorkLayerPreviewPort(activeWorkLayer);

  return (
    <WorkLayerProvider active={activeWorkLayer} port={workLayerPort}>
      <WorkspaceViewportProvider profile={profile}>
        {children}
      </WorkspaceViewportProvider>
    </WorkLayerProvider>
  );
}
