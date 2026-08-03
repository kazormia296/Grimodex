// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { workspaceState, editorLifecycle } = vi.hoisted(() => ({
  workspaceState: {
    view: "editor",
    activeWorkspacePath: "/workspace/novel" as string | null,
    workspaceOpenRevision: 1,
  },
  editorLifecycle: {
    mounts: 0,
    unmounts: 0,
  },
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) =>
    selector(workspaceState),
}));
vi.mock("@/runtime/runtimeCapabilitiesContext", () => ({
  useRuntimeCapabilities: () => ({ genericProjectTransfer: false }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ Toaster: () => null }));
vi.mock("@/features/workspace/WelcomeScreen", () => ({
  WelcomeScreen: () => null,
}));
vi.mock("@/features/workspace/LauncherScreen", () => ({
  LauncherScreen: () => null,
}));
vi.mock("@/features/workspace/WorkspaceTrustDialog", () => ({
  WorkspaceTrustDialog: () => null,
}));
vi.mock("@/features/legal/EulaConsentDialog", () => ({
  EulaConsentDialog: () => null,
}));
vi.mock("@/features/release-notes/ReleaseNotesDialog", () => ({
  ReleaseNotesDialog: () => null,
}));
vi.mock("@/lib/DebugLogViewer", () => ({ DebugLogViewer: () => null }));
vi.mock("@/components/GrimodexLogo", () => ({ GrimodexLogo: () => null }));
vi.mock("@/components/a11y/LiveRegion", () => ({ LiveRegion: () => null }));
vi.mock("@/components/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("@/components/CloseSaveFailureDialog", () => ({
  CloseSaveFailureDialog: () => null,
}));
vi.mock("@/application/lifecycle/LifecycleStatus", () => ({
  LifecycleStatus: () => null,
}));
vi.mock("@/application/bootstrap/ApplicationBootstrapHost", () => ({
  ApplicationBootstrapHost: () => null,
}));
vi.mock("@/features/editor/EditorWorkspaceController", async () => {
  const { useEffect } = await import("react");
  return {
    EditorWorkspaceController: () => {
      useEffect(() => {
        editorLifecycle.mounts += 1;
        return () => {
          editorLifecycle.unmounts += 1;
        };
      }, []);
      return null;
    },
  };
});

import App from "./App";

describe("App Workspace identity boundary", () => {
  beforeEach(() => {
    workspaceState.view = "editor";
    workspaceState.activeWorkspacePath = "/workspace/novel";
    workspaceState.workspaceOpenRevision = 1;
    editorLifecycle.mounts = 0;
    editorLifecycle.unmounts = 0;
  });

  it("remounts the editor controller after a same-path Workspace reopen", () => {
    const rendered = render(<App />);
    expect(editorLifecycle).toEqual({ mounts: 1, unmounts: 0 });

    workspaceState.workspaceOpenRevision = 2;
    rendered.rerender(<App />);

    expect(editorLifecycle).toEqual({ mounts: 2, unmounts: 1 });
  });
});
