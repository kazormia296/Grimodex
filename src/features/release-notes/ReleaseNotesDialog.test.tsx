// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import {
  useReleaseNotesStore,
  _resetReleaseNotesStoreForTests,
} from "./releaseNotesStore";

const updateGlobalSettings = vi.fn();

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ updateGlobalSettings }),
}));

vi.mock("@/features/settings/categories/about/MarkdownDoc", () => ({
  MarkdownDoc: ({ src }: { src: string }) => (
    <div data-testid={`markdown-${src}`}>{src}</div>
  ),
}));

beforeEach(() => {
  updateGlobalSettings.mockReset();
  updateGlobalSettings.mockResolvedValue(true);
  _resetReleaseNotesStoreForTests();
});

describe("ReleaseNotesDialog", () => {
  it("renders when store is open", () => {
    useReleaseNotesStore.getState().openAuto({
      version: "0.10.4",
      src: "RELEASE_NOTES/v0.10.4.ja.md",
      isFallback: false,
    });
    render(<ReleaseNotesDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByTestId("markdown-RELEASE_NOTES/v0.10.4.ja.md"),
    ).toBeInTheDocument();
  });

  it("auto close persists lastSeen", async () => {
    useReleaseNotesStore.getState().openAuto({
      version: "0.10.4",
      src: "RELEASE_NOTES/v0.10.4.ja.md",
      isFallback: false,
    });
    render(<ReleaseNotesDialog />);
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      lastSeenReleaseNotesVersion: "0.10.4",
    });
  });

  it("manual close does not persist lastSeen", async () => {
    useReleaseNotesStore.getState().openManual({
      version: "0.10.4",
      src: "RELEASE_NOTES/v0.10.4.ja.md",
      isFallback: false,
    });
    render(<ReleaseNotesDialog />);
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });
});
