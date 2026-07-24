import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceViewportProfile } from "./viewportProfile";

const WorkspaceViewportContext = createContext<WorkspaceViewportProfile | null>(
  null,
);

export function WorkspaceViewportProvider({
  profile,
  children,
}: {
  profile: WorkspaceViewportProfile;
  children: ReactNode;
}) {
  return (
    <WorkspaceViewportContext.Provider value={profile}>
      {children}
    </WorkspaceViewportContext.Provider>
  );
}

export function useWorkspaceViewportProfile(): WorkspaceViewportProfile {
  return useContext(WorkspaceViewportContext) ?? "wide";
}
