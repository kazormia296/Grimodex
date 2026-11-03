// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";

const h = vi.hoisted(() => ({ read: vi.fn(), count: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/sceneScopeDefault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sceneScopeDefault")>()),
  readScopeProjectDefault: h.read,
}));
vi.mock("./applyScopeDefault", () => ({
  countScopeMarkers: h.count,
  applyScopeDefaultToScenes: h.apply,
}));
vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import { ScopeDefaultApplyPanel } from "./ScopeDefaultApplyPanel";
import { ChapterScopeDefaultDialog } from "./ChapterScopeDefaultDialog";

const LOCAL = {
  timeline: { kind: "exact", ref: "timeline:local" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.read.mockResolvedValue({
    projectId: "project-1",
    default: { state: "set", queryIdentity: LOCAL, materialConstraint: LOCAL },
    version: 7,
    sourceToken: null,
    updatedAt: null,
  });
  h.count.mockResolvedValue({
    unknown: 2,
    legacyAbsent: 1,
    explicit: 0,
    failed: 0,
  });
  h.apply.mockResolvedValue({
    status: "done",
    applied: 2,
    skipped: 0,
    failed: 0,
  });
});
afterEach(cleanup);

describe("ScopeDefaultApplyPanel（PR-2 review P2-1）", () => {
  it("names the saved default in the confirmation and applies only that version", async () => {
    render(
      <ScopeDefaultApplyPanel
        workspacePath="/workspace"
        projectId="project-1"
        sceneIds={["a", "b"]}
      />,
    );
    fireEvent.click(screen.getByTestId("scope-default-apply-unset"));
    const confirm = await screen.findByTestId("scope-default-apply-confirm");
    expect(confirm.textContent).toContain('"count":2');
    expect(confirm.textContent).toContain("timeline:local");
    fireEvent.click(screen.getByTestId("scope-default-apply-run"));
    await waitFor(() =>
      expect(h.apply).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        projectId: "project-1",
        sceneIds: ["a", "b"],
        target: "unknown",
        expectedVersion: 7,
      }),
    );
  });

  it("reports a default changed after the confirmation instead of a count", async () => {
    h.apply.mockResolvedValue({ status: "default-changed" });
    render(
      <ScopeDefaultApplyPanel
        workspacePath="/workspace"
        projectId="project-1"
        sceneIds={["a"]}
      />,
    );
    fireEvent.click(screen.getByTestId("scope-default-apply-unset"));
    fireEvent.click(await screen.findByTestId("scope-default-apply-run"));
    expect(
      (await screen.findByTestId("scope-default-apply-message")).textContent,
    ).toBe("settings.project.sceneScopeDefaultConflict");
  });

  it("does not offer the earlier-scene action unless asked", () => {
    render(
      <ScopeDefaultApplyPanel
        workspacePath="/workspace"
        projectId="project-1"
        sceneIds={["a"]}
      />,
    );
    expect(screen.queryByTestId("scope-default-apply-legacy")).toBeNull();
  });
});

describe("ChapterScopeDefaultDialog（SDEF/1 R16）", () => {
  it("applies only to the chapter's Scenes and offers no earlier-scene action", async () => {
    useWorkspaceStore.setState({ activeWorkspacePath: "/workspace" } as never);
    useTreeStore.setState({
      nodes: [
        {
          id: "ch",
          parentId: null,
          nodeType: "folder",
          projectId: "project-1",
        },
        { id: "s1", parentId: "ch", nodeType: "scene", projectId: "project-1" },
        { id: "s2", parentId: null, nodeType: "scene", projectId: "project-1" },
      ],
    } as never);
    render(
      <ChapterScopeDefaultDialog
        folderId="ch"
        title="第一章"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("scope-default-apply-legacy")).toBeNull();
    fireEvent.click(screen.getByTestId("scope-default-apply-unset"));
    await waitFor(() =>
      expect(h.count).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        projectId: "project-1",
        sceneIds: ["s1"],
      }),
    );
  });
});
