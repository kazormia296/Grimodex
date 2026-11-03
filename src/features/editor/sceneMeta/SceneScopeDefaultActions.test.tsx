// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "./sceneScopeTypes";

const h = vi.hoisted(() => ({ read: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/sceneScopeDefault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sceneScopeDefault")>()),
  readScopeProjectDefault: h.read,
}));
vi.mock("@/features/scene-scope-default/applyScopeDefault", () => ({
  applyScopeDefaultToScenes: h.apply,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SceneScopeDefaultActions } from "./SceneScopeDefaultActions";

const MAIN = {
  timeline: { kind: "exact", ref: "timeline:main" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
} as const;

function binding(
  marker: Binding["compatibilityMarker"],
  query: Binding["queryIdentity"] = MAIN,
): Binding {
  return {
    schemaVersion: 1,
    projectId: "project-1",
    sceneId: "scene-1",
    sceneIncarnationId: "inc",
    compatibilityMarker: marker,
    queryIdentity: query,
    materialConstraint: query,
    knowledgeHolder: { kind: "reader" },
    audience: { kind: "reader" },
    version: 2,
    sourceToken: "t",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.read.mockResolvedValue({
    projectId: "project-1",
    default: { state: "set", queryIdentity: MAIN, materialConstraint: MAIN },
    version: 1,
    sourceToken: null,
    updatedAt: null,
  });
});
afterEach(cleanup);

describe("SceneScopeDefaultActions（rev2 §7.3、DR-SDEF-30・32）", () => {
  it("shows the default badge for an explicit Scene equal to the default, and no apply action", async () => {
    render(
      <SceneScopeDefaultActions
        workspacePath="/workspace"
        binding={binding("explicit")}
        onApplied={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("scene-scope-default-badge")).toBeTruthy();
    expect(screen.queryByTestId("scene-scope-apply-default")).toBeNull();
    expect(screen.queryByTestId("scene-scope-not-main-line")).toBeNull();
  });

  it("notes an explicit Scene outside the main line", async () => {
    render(
      <SceneScopeDefaultActions
        workspacePath="/workspace"
        binding={binding("explicit", {
          ...MAIN,
          timeline: { kind: "exact", ref: "timeline:flashback" },
        })}
        onApplied={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("scene-scope-not-main-line")).toBeTruthy();
    expect(screen.queryByTestId("scene-scope-default-badge")).toBeNull();
  });

  it("asks before applying to an unset Scene, then reloads after a write", async () => {
    h.apply.mockResolvedValue({
      status: "done",
      applied: 1,
      skipped: 0,
      failed: 0,
    });
    const onApplied = vi.fn();
    render(
      <SceneScopeDefaultActions
        workspacePath="/workspace"
        binding={binding("unknown")}
        onApplied={onApplied}
      />,
    );
    fireEvent.click(await screen.findByTestId("scene-scope-apply-default"));
    expect(screen.getByTestId("scene-scope-apply-confirm")).toBeTruthy();
    expect(h.apply).not.toHaveBeenCalled();
    expect(screen.queryByTestId("scene-scope-apply-legacy-warning")).toBeNull();
    fireEvent.click(screen.getByTestId("scene-scope-apply-run"));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(h.apply).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      projectId: "project-1",
      sceneIds: ["scene-1"],
      target: "unknown",
    });
  });

  it("warns that an earlier Scene cannot go back and uses its own target", async () => {
    h.apply.mockResolvedValue({
      status: "done",
      applied: 1,
      skipped: 0,
      failed: 0,
    });
    render(
      <SceneScopeDefaultActions
        workspacePath="/workspace"
        binding={binding("legacy-absent")}
        onApplied={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByTestId("scene-scope-apply-default"));
    expect(screen.getByTestId("scene-scope-apply-legacy-warning")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scene-scope-apply-run"));
    await waitFor(() =>
      expect(h.apply).toHaveBeenCalledWith(
        expect.objectContaining({ target: "legacy-absent" }),
      ),
    );
  });

  it("offers nothing when the project has no default", async () => {
    h.read.mockResolvedValue({
      projectId: "project-1",
      default: { state: "none" },
      version: 0,
      sourceToken: null,
      updatedAt: null,
    });
    render(
      <SceneScopeDefaultActions
        workspacePath="/workspace"
        binding={binding("unknown")}
        onApplied={vi.fn()}
      />,
    );
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    expect(screen.queryByTestId("scene-scope-apply-default")).toBeNull();
  });
});
