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
vi.mock("@/lib/a11y/announcer", () => ({ announce: vi.fn() }));

import { TimelapseExportSection } from "./TimelapseExportSection";
import { toast } from "sonner";
import { announce } from "@/lib/a11y/announcer";

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
          targetDurationSec: 30,
        }),
      ),
    );
    // Standard pace leaves maxIdleMs to the scheduler default (not passed).
    const firstCall = exportMock.produceSceneTimelapseWebm.mock
      .calls[0] as unknown as [{ maxIdleMs?: number }];
    expect(firstCall[0].maxIdleMs).toBeUndefined();
    await waitFor(() => expect(exportMock.saveWebmBlob).toHaveBeenCalled());
    expect(exportMock.produceProjectTimelapseWebm).not.toHaveBeenCalled();
  });

  it("passes the selected duration and pace (maxIdleMs)", async () => {
    render(<TimelapseExportSection />);
    const [durationSel, paceSel] = screen.getAllByRole("combobox");
    fireEvent.change(durationSel, { target: { value: "60" } });
    fireEvent.change(paceSel, { target: { value: "fast" } });
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() =>
      expect(exportMock.produceSceneTimelapseWebm).toHaveBeenCalledWith(
        expect.objectContaining({ targetDurationSec: 60, maxIdleMs: 800 }),
      ),
    );
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

  it("shows an error toast when the scene has no recorded steps", async () => {
    exportMock.produceSceneTimelapseWebm.mockRejectedValueOnce(
      new Error("timelapse: no recorded editor steps for this scene"),
    );
    render(<TimelapseExportSection />);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("shows an error toast on a generic export failure", async () => {
    exportMock.produceSceneTimelapseWebm.mockRejectedValueOnce(
      new Error("internal error"),
    );
    render(<TimelapseExportSection />);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("announces export start once; completion is left to the toast", async () => {
    render(<TimelapseExportSection />);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    expect(vi.mocked(announce)).toHaveBeenCalledWith("書き出し中…");
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled());
    // Sonner has its own aria-live — no second announce on completion.
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
  });

  it("announces start but not failure (error toast covers it)", async () => {
    exportMock.produceSceneTimelapseWebm.mockRejectedValueOnce(
      new Error("internal error"),
    );
    render(<TimelapseExportSection />);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
  });

  it("marks the export button aria-busy while exporting", async () => {
    let resolveExport!: (v: {
      blob: Blob;
      frameCount: number;
      eventCount: number;
    }) => void;
    exportMock.produceSceneTimelapseWebm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
    );
    render(<TimelapseExportSection />);
    const btn = screen.getByTestId("timelapse-export-video");
    expect(btn).toHaveAttribute("aria-busy", "false");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
    resolveExport({ blob: new Blob(["x"]), frameCount: 1, eventCount: 1 });
    await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "false"));
  });

  it("does not show a success toast when the save dialog is cancelled", async () => {
    exportMock.saveWebmBlob.mockResolvedValueOnce(false);
    render(<TimelapseExportSection />);
    fireEvent.click(screen.getByTestId("timelapse-export-video"));
    await waitFor(() => expect(exportMock.saveWebmBlob).toHaveBeenCalled());
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});
