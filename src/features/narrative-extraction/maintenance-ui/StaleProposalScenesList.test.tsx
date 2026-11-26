// @vitest-environment happy-dom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaleProposalScenesPage } from "@/application/narrative-extraction/nativeApi";
import enLocale from "@/locales/en.json";
import jaLocale from "@/locales/ja.json";

const { scenesMock, openMock, blockedMock, pendingMock } = vi.hoisted(() => ({
  scenesMock: vi.fn(),
  openMock: vi.fn(),
  blockedMock: vi.fn(),
  pendingMock: vi.fn(),
}));

vi.mock("@/application/narrative-extraction/nativeApi", () => ({
  narrativeMaintenanceStaleProposalScenes: scenesMock,
}));
vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument: openMock,
}));
vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: { isNavigationBlocked: blockedMock },
}));
vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: pendingMock,
}));
// A real zustand store, so the list has to subscribe to see later changes.
vi.mock("@/features/tree/treeStore", async () => {
  const { create } = await import("zustand");
  return {
    useTreeStore: create(() => ({
      nodes: [] as { id: string; nodeType: string; title: string }[],
      hydratedProjectId: null as string | null,
    })),
    // Manuscript order is the array order here.
    getAllProjectScenesInOrder: (
      nodes: { id: string; nodeType: string; title: string }[],
    ) => nodes.filter((node) => node.nodeType === "scene"),
  };
});

import { useTreeStore } from "@/features/tree/treeStore";
import { StaleProposalScenesList } from "./StaleProposalScenesList";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SceneTexts = typeof jaLocale.narrativeMaintenance.scenes;
const either = (pick: (texts: SceneTexts) => string) => [
  pick(jaLocale.narrativeMaintenance.scenes),
  pick(enLocale.narrativeMaintenance.scenes),
];

const setTree = (patch: {
  nodes?: { id: string; nodeType: string; title: string }[];
  hydratedProjectId?: string | null;
}) => useTreeStore.setState(patch as never);

const rowTexts = () =>
  screen
    .getAllByTestId("structure-health-scene-row")
    .map((row) => row.textContent ?? "");

describe("StaleProposalScenesList", () => {
  beforeEach(() => {
    scenesMock.mockReset();
    openMock.mockReset();
    blockedMock.mockReset().mockReturnValue(false);
    pendingMock.mockReset().mockReturnValue(false);
    setTree({
      hydratedProjectId: "project-1",
      nodes: [
        { id: "scene-b", nodeType: "scene", title: "港の朝" },
        { id: "folder", nodeType: "folder", title: "章" },
        { id: "scene-a", nodeType: "scene", title: "" },
      ],
    });
  });

  it("lists cited scenes in manuscript order and opens one", async () => {
    scenesMock.mockResolvedValue({
      scenes: [
        { sceneId: "scene-a", proposalCount: 2 },
        { sceneId: "scene-b", proposalCount: 5 },
      ],
      withoutSceneCount: 0,
    });
    const onOpened = vi.fn();
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={onOpened} />,
    );
    await screen.findAllByTestId("structure-health-scene-row");

    expect(scenesMock).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1",
    });
    const rows = rowTexts();
    expect(rows[0]).toContain("港の朝");
    expect(rows[0]).toContain("5");
    expect(
      either((s) => s.untitled).some((text) => rows[1].includes(text)),
    ).toBe(true);
    expect(screen.queryByTestId("structure-health-scene-without")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "港の朝" }));
    expect(openMock).toHaveBeenCalledExactlyOnceWith(
      {
        target: { kind: "scene", documentId: "scene-b" },
        mode: "pinned",
        revealEditor: true,
        focusEditor: true,
        syncSceneContext: true,
      },
      { isNavigationBlocked: blockedMock },
    );
    expect(onOpened).toHaveBeenCalledOnce();
  });

  it.each([
    ["inline AI is pending", () => pendingMock.mockReturnValue(true)],
    ["the editor refuses to leave", () => blockedMock.mockReturnValue(true)],
  ])("keeps the list open when %s", async (_label, block) => {
    block();
    scenesMock.mockResolvedValue({
      scenes: [{ sceneId: "scene-b", proposalCount: 1 }],
      withoutSceneCount: 0,
    });
    const onOpened = vi.fn();
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={onOpened} />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "港の朝" }),
    );

    expect(openMock).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
    expect(screen.getByTestId("structure-health-scene-row")).toBeVisible();
  });

  it("calls an unknown id deleted, and shows proposals without a scene", async () => {
    scenesMock.mockResolvedValue({
      scenes: [{ sceneId: "gone", proposalCount: 1 }],
      withoutSceneCount: 3,
    });
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={() => {}} />,
    );
    await screen.findAllByTestId("structure-health-scene-row");

    expect(
      either((s) => s.missing).some((text) => rowTexts()[0].includes(text)),
    ).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByTestId("structure-health-scene-without"),
    ).toHaveTextContent("3");
  });

  it("does not call a scene deleted before this project's tree is loaded", async () => {
    setTree({ hydratedProjectId: "other-project" });
    scenesMock.mockResolvedValue({
      scenes: [{ sceneId: "scene-b", proposalCount: 1 }],
      withoutSceneCount: 0,
    });
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={() => {}} />,
    );
    await screen.findAllByTestId("structure-health-scene-row");

    const text = rowTexts()[0];
    expect(
      either((s) => s.treeLoading).some((label) => text.includes(label)),
    ).toBe(true);
    expect(text).not.toContain("港の朝");
    expect(screen.queryByRole("button")).toBeNull();

    // The rows update once this project's tree arrives.
    act(() => setTree({ hydratedProjectId: "project-1" }));
    expect(screen.getByRole("button", { name: "港の朝" })).toBeVisible();
  });

  it("loads the next page with the cursor and keeps each scene once", async () => {
    scenesMock
      .mockResolvedValueOnce({
        scenes: [{ sceneId: "scene-b", proposalCount: 1 }],
        withoutSceneCount: 0,
        nextCursor: "scene-b",
      })
      .mockResolvedValueOnce({
        scenes: [
          { sceneId: "scene-b", proposalCount: 1 },
          { sceneId: "scene-a", proposalCount: 4 },
        ],
        withoutSceneCount: 0,
      });
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={() => {}} />,
    );
    await userEvent.click(
      await screen.findByTestId("structure-health-scenes-more"),
    );

    await waitFor(() => expect(rowTexts()).toHaveLength(2));
    expect(scenesMock).toHaveBeenLastCalledWith({
      projectId: "project-1",
      cursor: "scene-b",
    });
    expect(screen.queryByTestId("structure-health-scenes-more")).toBeNull();
  });

  it("keeps the loaded rows when the next page fails", async () => {
    scenesMock
      .mockResolvedValueOnce({
        scenes: [{ sceneId: "scene-b", proposalCount: 1 }],
        withoutSceneCount: 0,
        nextCursor: "scene-b",
      })
      .mockRejectedValueOnce(new Error("boom"));
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={() => {}} />,
    );
    await userEvent.click(
      await screen.findByTestId("structure-health-scenes-more"),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("boom");
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByTestId("structure-health-scenes-more")).toBeEnabled();
  });

  it("shows a failure without echoing the error", async () => {
    scenesMock.mockRejectedValue(new Error("boom"));
    render(
      <StaleProposalScenesList projectId="project-1" onOpened={() => {}} />,
    );
    const alert = await screen.findByRole("alert");
    expect(either((s) => s.failed)).toContain(alert.textContent);
    expect(screen.queryByTestId("structure-health-scene-row")).toBeNull();
  });

  it("drops the answer for a project it no longer shows", async () => {
    const first = deferred<StaleProposalScenesPage>();
    const second = deferred<StaleProposalScenesPage>();
    scenesMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = render(
      <StaleProposalScenesList projectId="project-1" onOpened={() => {}} />,
    );
    setTree({ hydratedProjectId: "project-2" });
    view.rerender(
      <StaleProposalScenesList projectId="project-2" onOpened={() => {}} />,
    );
    await act(async () => {
      second.resolve({
        scenes: [{ sceneId: "scene-b", proposalCount: 2 }],
        withoutSceneCount: 0,
      });
    });
    await act(async () => {
      first.resolve({
        scenes: [{ sceneId: "scene-a", proposalCount: 9 }],
        withoutSceneCount: 0,
      });
    });

    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain("港の朝");
    expect(rowTexts()[0]).not.toContain("9");
  });
});
