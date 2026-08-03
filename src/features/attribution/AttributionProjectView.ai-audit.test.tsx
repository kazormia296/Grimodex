// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildBundle,
  captureIdentity,
  downloadBundle,
  frozenReadProof,
  runBoundary,
} = vi.hoisted(() => ({
  buildBundle: vi.fn(),
  captureIdentity: vi.fn(),
  downloadBundle: vi.fn(),
  frozenReadProof: { testOnly: true },
  runBoundary: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (state: unknown) => unknown) =>
    selector({ nodes: [], setActiveScene: vi.fn() }),
}));
vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => "project-1",
}));
vi.mock("./attributionStore", () => ({
  useAttributionStore: (selector: (state: unknown) => unknown) =>
    selector({ setScope: vi.fn() }),
}));
vi.mock("./projectStats", () => ({
  loadProjectAttributionStats: vi.fn(async () => ({})),
  loadKnowledgeAttributionStats: vi.fn(async () => ({})),
}));
vi.mock("./projectAuthorship", () => ({
  buildProjectAuthorshipReport: vi.fn(),
}));
vi.mock("./exportReport", () => ({
  exportAuthorshipJson: vi.fn(),
  exportAuthorshipHtml: vi.fn(),
  downloadTextFile: vi.fn(),
}));
vi.mock("./ProvenanceAnalyticsSection", () => ({
  ProvenanceAnalyticsSection: () => null,
}));
vi.mock("@/features/ai-audit/exportBoundary", () => ({
  captureAiAuditExportIdentity: captureIdentity,
  runAiAuditExportBoundary: runBoundary,
}));
vi.mock("@/features/ai-audit/exportBundle", () => ({
  buildAiAuditBundle: buildBundle,
  downloadAiAuditBundle: downloadBundle,
}));

import { AttributionProjectView } from "./AttributionProjectView";

describe("AttributionProjectView AI audit export", () => {
  beforeEach(() => {
    buildBundle.mockReset();
    captureIdentity.mockReset();
    downloadBundle.mockReset();
    runBoundary.mockReset();
    captureIdentity.mockReturnValue({
      projectId: "project-1",
      workspace: { path: "/workspace", openRevision: 1 },
    });
    runBoundary.mockImplementation(
      async (
        _identity: unknown,
        readFrozenState: (proof: unknown) => Promise<unknown>,
      ) => readFrozenState(frozenReadProof),
    );
    buildBundle.mockResolvedValue({
      bytes: new Uint8Array([1]),
      filename: "audit.zip",
      manifest: {
        integrityLimitations: { verificationFailed: false },
      },
    });
  });

  it("keeps the audit ZIP available and exports it when the project has no chapters", async () => {
    render(<AttributionProjectView />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "attribution.exportAiAuditBundle",
      }),
    );

    await waitFor(() => {
      expect(buildBundle).toHaveBeenCalledWith("project-1", {
        frozenReadProof,
      });
    });
    expect(captureIdentity).toHaveBeenCalledWith("project-1");
    expect(runBoundary).toHaveBeenCalledOnce();
    expect(downloadBundle).toHaveBeenCalledWith(
      new Uint8Array([1]),
      "audit.zip",
    );
    expect(screen.getByText("chat.noScenes")).toBeInTheDocument();
  });

  it("does not build or download a partial ZIP when quiescence fails", async () => {
    runBoundary.mockRejectedValueOnce(new Error("autosave flush failed"));
    render(<AttributionProjectView />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "attribution.exportAiAuditBundle",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("attribution.aiAudit.exportFailed"),
      ).toBeVisible();
    });
    expect(buildBundle).not.toHaveBeenCalled();
    expect(downloadBundle).not.toHaveBeenCalled();
  });
});
