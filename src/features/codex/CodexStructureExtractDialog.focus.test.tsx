// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi")
    >()),
    getNarrativeRuntimePolicy: vi.fn(async () => ({
      runtimeMode: "review-only",
      effectiveMode: "review-only",
      maintenanceEnabled: false,
      maintenancePreviewAllowed: false,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    })),
  }),
);
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("./codexStructureExtractionApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codexStructureExtractionApi")>()),
  restoreCodexStructureExtractionReview: vi.fn(async () => null),
}));

import { CodexStructureExtractDialog } from "./CodexStructureExtractDialog";
import { resetCodexStructureExtractionStoreForTests } from "./codexStructureExtractionStore";

describe("CodexStructureExtractDialog focus return", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
  });

  it("gives focus back to the element that had it when the dialog opened (it has no trigger)", async () => {
    const opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const view = render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} />,
    );
    await screen.findByTestId("codex-structure-extract-dialog");
    // Radix moves focus into the dialog.
    await waitFor(() => expect(document.activeElement).not.toBe(opener));

    view.rerender(
      <CodexStructureExtractDialog open={false} onOpenChange={vi.fn()} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("does not try to focus an opener that is gone", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} />,
    );
    await screen.findByTestId("codex-structure-extract-dialog");
    opener.remove();

    view.rerender(
      <CodexStructureExtractDialog open={false} onOpenChange={vi.fn()} />,
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("codex-structure-extract-dialog"),
      ).not.toBeInTheDocument(),
    );
    expect(document.activeElement).not.toBe(opener);
  });
});
