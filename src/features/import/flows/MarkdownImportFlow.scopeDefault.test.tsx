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
  applyAfterImport: vi.fn(),
  reloadTree: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("../importApi", () => ({
  importChapters: h.importChapters,
  importTree: h.importTree,
  importProjectMetadata: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../importTarget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../importTarget")>();
  return {
    ...actual,
    prepareImportTarget: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/features/scene-scope-default/importApply", () => ({
  applyScopeDefaultAfterImport: h.applyAfterImport,
}));
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
  h.reloadTree.mockResolvedValue(undefined);
  h.applyAfterImport.mockResolvedValue(null);
  h.importChapters.mockResolvedValue({
    imported: 2,
    errors: [],
    sceneIds: ["scene-imported"],
  });
  h.importTree.mockResolvedValue({ imported: 0, errors: [], sceneIds: [] });
});

afterEach(cleanup);

async function runImport(
  applyScopeDefault: false | { expectedVersion: number },
) {
  const { container } = render(
    <MarkdownImportFlow
      importTarget="currentProject"
      markdownMode="single"
      onMarkdownModeChange={vi.fn()}
      onClose={vi.fn()}
      allowNativeFolderPicker={false}
      enforceBrowserLimits
      applyScopeDefault={applyScopeDefault}
    />,
  );
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: {
      files: [
        new File(["# Fixture\n\n## Chapter\n\n### Scene\n\nBody"], "a.md", {
          type: "text/markdown",
        }),
      ],
    },
  });
  await screen.findByText("import.preview");
  fireEvent.click(screen.getByRole("button", { name: "import.importButton" }));
  await waitFor(() => expect(h.applyAfterImport).toHaveBeenCalledTimes(1));
}

describe("取り込みのチェック（SDEF/1 R14、A7、DR-SDEF-31）", () => {
  it("passes the OFF state with the imported Scenes after the import finished", async () => {
    await runImport(false);
    expect(h.applyAfterImport).toHaveBeenCalledWith(false, ["scene-imported"]);
    expect(h.importChapters.mock.invocationCallOrder[0]).toBeLessThan(
      h.applyAfterImport.mock.invocationCallOrder[0]!,
    );
  });

  it("passes the ON state with the imported Scenes after the import finished", async () => {
    await runImport({ expectedVersion: 3 });
    expect(h.applyAfterImport).toHaveBeenCalledWith({ expectedVersion: 3 }, [
      "scene-imported",
    ]);
  });
});
