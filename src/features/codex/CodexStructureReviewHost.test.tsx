// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  enabled: true,
  projectId: "p1",
  moduleLoads: vi.fn(),
  loadDismissed: vi.fn(),
  extract: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => mocks.projectId,
}));
vi.mock("./codexStructureExtractionFlag", () => ({
  isCodexStructureExtractionReviewEnabled: () => mocks.enabled,
}));
vi.mock("./candidateExtractor", () => ({
  extractCodexCandidatesResult: mocks.extract,
}));
vi.mock("./codexCandidateDismissals", () => ({
  loadDismissedCandidateKeys: mocks.loadDismissed,
  saveDismissedCandidateKeys: vi.fn(),
}));
vi.mock("./CodexStructureExtractDialog", () => {
  mocks.moduleLoads();
  return {
    CodexStructureExtractDialog: ({
      open,
      onOpenChange,
      dismissedCandidateKeys,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      dismissedCandidateKeys?: ReadonlySet<string>;
    }) => (
      <>
        <div
          data-testid="structure-dialog"
          data-open={String(open)}
          data-dismissed-keys={
            dismissedCandidateKeys
              ? [...dismissedCandidateKeys].sort().join(",")
              : "undefined"
          }
        />
        <button
          type="button"
          data-testid="structure-dialog-close"
          onClick={() => onOpenChange(false)}
        />
      </>
    ),
  };
});

import { useCodexCandidateHostStore } from "./codexCandidateHostStore";
import { CodexStructureReviewHost } from "./CodexStructureReviewHost";

beforeEach(() => {
  mocks.enabled = true;
  mocks.projectId = "p1";
  mocks.moduleLoads.mockClear();
  mocks.loadDismissed.mockReset().mockResolvedValue(new Set());
  mocks.extract.mockReset();
  useCodexCandidateHostStore.getState().reset();
});

afterEach(() => cleanup());

describe("CodexStructureReviewHost", () => {
  it("returns nothing and never loads the dialog module while the flag is closed", async () => {
    mocks.enabled = false;
    render(<CodexStructureReviewHost />);
    // 薄い殻は、旗が閉じていれば本体（store・却下の読込・Dialog）を読み込まない。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByTestId("structure-dialog")).toBeNull();
    expect(mocks.loadDismissed).not.toHaveBeenCalled();
    expect(mocks.moduleLoads).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("does not load the dialog until it has been opened", async () => {
    render(<CodexStructureReviewHost />);

    await waitFor(() => expect(mocks.loadDismissed).toHaveBeenCalledWith("p1"));
    expect(screen.queryByTestId("structure-dialog")).toBeNull();
    expect(mocks.moduleLoads).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("opens without a Report, retains its mount after close, and updates dismissed keys", async () => {
    let resolveDismissed!: (keys: Set<string>) => void;
    mocks.loadDismissed.mockReturnValue(
      new Promise<Set<string>>((resolve) => {
        resolveDismissed = resolve;
      }),
    );
    render(<CodexStructureReviewHost />);
    await waitFor(() => expect(mocks.loadDismissed).toHaveBeenCalledWith("p1"));

    act(() => useCodexCandidateHostStore.getState().openStructureReview());
    const dialog = await screen.findByTestId("structure-dialog");
    expect(dialog.getAttribute("data-open")).toBe("true");
    expect(dialog.getAttribute("data-dismissed-keys")).toBe("undefined");
    expect(mocks.moduleLoads).toHaveBeenCalledTimes(1);
    expect(mocks.extract).not.toHaveBeenCalled();

    resolveDismissed(new Set(["key-b", "key-a"]));
    await waitFor(() =>
      expect(dialog.getAttribute("data-dismissed-keys")).toBe("key-a,key-b"),
    );

    await userEvent.click(screen.getByTestId("structure-dialog-close"));
    expect(
      screen.getByTestId("structure-dialog").getAttribute("data-open"),
    ).toBe("false");
    expect(useCodexCandidateHostStore.getState().structureEverOpened).toBe(
      true,
    );
  });
});
