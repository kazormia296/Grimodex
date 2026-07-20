// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  importChapters: vi.fn(),
  importTree: vi.fn(),
  importProjectMetadata: vi.fn(),
  prepareImportTarget: vi.fn(),
  reloadTree: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { error: h.toastError, success: vi.fn() },
}));
vi.mock("../importApi", () => ({
  importChapters: h.importChapters,
  importTree: h.importTree,
  importProjectMetadata: h.importProjectMetadata,
}));
vi.mock("../importTarget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../importTarget")>();
  return { ...actual, prepareImportTarget: h.prepareImportTarget };
});
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "default-project",
}));
vi.mock("@/features/project/api", () => ({
  getProject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (
    selector: (state: { loadTree: typeof h.reloadTree }) => unknown,
  ) => selector({ loadTree: h.reloadTree }),
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));

import { MarkdownImportFlow } from "./MarkdownImportFlow";

beforeEach(() => {
  vi.clearAllMocks();
  h.prepareImportTarget.mockResolvedValue(undefined);
  h.reloadTree.mockResolvedValue(undefined);
  h.importProjectMetadata.mockResolvedValue(undefined);
  h.importTree.mockResolvedValue({ imported: 0, errors: [] });
});

afterEach(cleanup);

describe("MarkdownImportFlow failure recovery", () => {
  it("returns to an unlocked preview when the import pipeline rejects", async () => {
    let rejectImport: ((reason?: unknown) => void) | undefined;
    h.importChapters.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectImport = reject;
        }),
    );
    const onBusyChange = vi.fn();
    const onFailedChange = vi.fn();
    const { container } = render(
      <MarkdownImportFlow
        importTarget="currentProject"
        markdownMode="single"
        onMarkdownModeChange={vi.fn()}
        onClose={vi.fn()}
        allowNativeFolderPicker={false}
        enforceBrowserLimits
        onBusyChange={onBusyChange}
        onFailedChange={onFailedChange}
      />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: {
        files: [
          new File(
            ["# Failure fixture\n\n## Chapter\n\n### Scene\n\nBody"],
            "failure.md",
            { type: "text/markdown" },
          ),
        ],
      },
    });

    await screen.findByText("import.preview");
    fireEvent.click(
      screen.getByRole("button", { name: "import.importButton" }),
    );
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    rejectImport?.(new Error("database unavailable"));

    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(
      screen.queryByRole("button", { name: "import.importButton" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "import.close" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Error: database unavailable")).toBeInTheDocument();
    expect(h.toastError).toHaveBeenCalledWith("import.failed");
    expect(onFailedChange).toHaveBeenLastCalledWith(true);
  });
});
