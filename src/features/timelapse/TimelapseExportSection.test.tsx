// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  mime: "video/webm;codecs=vp9" as string | null,
  tabs: [{ nodeId: "s1", contentType: "scene" }] as {
    nodeId: string;
    contentType: string;
  }[],
  activeTabId: "s1" as string | null,
}));
const exportMock = vi.hoisted(() => ({
  produceSceneTimelapseWebm: vi.fn(() =>
    Promise.resolve({ blob: new Blob(["x"]), frameCount: 1, eventCount: 1 }),
  ),
  produceProjectTimelapseWebm: vi.fn(() =>
    Promise.resolve({
      blob: new Blob(["y"]),
      frameCount: 1,
      eventCount: 1,
      sceneCount: 2,
    }),
  ),
  saveWebmBlob: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => "p1",
}));
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: (sel: (s: unknown) => unknown) =>
    sel({ tabs: state.tabs, activeTabId: state.activeTabId }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (sel: (s: unknown) => unknown) =>
    sel({ nodes: [{ id: "s1", title: "Scene One" }] }),
}));
vi.mock("./videoExport", () => ({ pickSupportedWebmMime: () => state.mime }));
vi.mock("./exportTimelapse", () => exportMock);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TimelapseExportSection } from "./TimelapseExportSection";

beforeEach(() => {
  vi.clearAllMocks();
  state.mime = "video/webm;codecs=vp9";
  state.tabs = [{ nodeId: "s1", contentType: "scene" }];
  state.activeTabId = "s1";
});

describe("TimelapseExportSection", () => {
  it("exports the active scene by default", async () => {
    render(<TimelapseExportSection />);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() =>
      expect(exportMock.produceSceneTimelapseWebm).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          sceneId: "s1",
          mimeType: "video/webm;codecs=vp9",
        }),
      ),
    );
    await waitFor(() => expect(exportMock.saveWebmBlob).toHaveBeenCalled());
    expect(exportMock.produceProjectTimelapseWebm).not.toHaveBeenCalled();
  });

  it("exports the whole project when the project scope is selected", async () => {
    render(<TimelapseExportSection />);
    const [, projectRadio] = screen.getAllByRole("radio");
    fireEvent.click(projectRadio);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() =>
      expect(exportMock.produceProjectTimelapseWebm).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          mimeType: "video/webm;codecs=vp9",
        }),
      ),
    );
    expect(exportMock.produceSceneTimelapseWebm).not.toHaveBeenCalled();
  });

  it("disables export when WebM is unsupported", () => {
    state.mime = null;
    render(<TimelapseExportSection />);
    expect(screen.getByTestId("timelapse-export-video")).toBeDisabled();
  });

  it("disables export in scene scope when no scene tab is active", () => {
    state.tabs = [{ nodeId: "c1", contentType: "codex" }];
    state.activeTabId = "c1";
    render(<TimelapseExportSection />);
    expect(screen.getByTestId("timelapse-export-video")).toBeDisabled();
  });

  it("allows project-scope export even with no active scene", async () => {
    state.tabs = [{ nodeId: "c1", contentType: "codex" }];
    state.activeTabId = "c1";
    render(<TimelapseExportSection />);
    const [, projectRadio] = screen.getAllByRole("radio");
    fireEvent.click(projectRadio);
    const btn = screen.getByTestId("timelapse-export-video");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(exportMock.produceProjectTimelapseWebm).toHaveBeenCalled(),
    );
  });
});
