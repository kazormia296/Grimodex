import type { ReactNode } from "react";

import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { WorkLayerProvider } from "@/features/work-layer/WorkLayerContext";
import { useWorkLayerPreviewPort } from "@/features/work-layer/useWorkLayerPreviewPort";
import { useWorkLayerLivePort } from "@/features/editor/useWorkLayerLivePort";

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
  const fixturePort = useWorkLayerPreviewPort(activeWorkLayer);
  const livePort = useWorkLayerLivePort(activeWorkLayer);
  const workLayerPort = fixturePort ?? livePort;

  return (
    <WorkLayerProvider active={activeWorkLayer} port={workLayerPort}>
      <WorkspaceViewportProvider profile={profile}>
        {children}
      </WorkspaceViewportProvider>
    </WorkLayerProvider>
  );
}
