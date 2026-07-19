// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceStore } from "@/lib/browser-db/indexedDbStore";
import { createBrowserMock } from "@/lib/browser-mock";
import {
  initializeBrowserRuntime,
  type WebEditorBrowserRuntime,
} from "@/lib/browserRuntime";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { MarkdownImportFlow } from "./MarkdownImportFlow";

const workspaceId = "web-import-integration";
const store = createMemoryWorkspaceStore();
let runtime: WebEditorBrowserRuntime;

function createExclusiveLockManager(): Pick<LockManager, "request"> {
  return {
    request: (async (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) =>
      callback({ name, mode: "exclusive" } as Lock)) as LockManager["request"],
  };
}

beforeAll(async () => {
  runtime = await initializeBrowserRuntime({
    workspaceId,
    store,
    lifecycleTarget: null,
    lockManager: createExclusiveLockManager(),
  });
});

afterAll(async () => {
  cleanup();
  await runtime.dispose();
});

describe("MarkdownImportFlow browser-local pipeline", () => {
  it("imports a user-selected File into BrowserMock without network transport", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    const sendBeacon = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    const { container } = render(
      <MarkdownImportFlow
        importTarget="currentProject"
        markdownMode="single"
        onMarkdownModeChange={vi.fn()}
        onClose={vi.fn()}
        allowNativeFolderPicker={false}
        enforceBrowserLimits
      />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: {
        files: [
          new File(
            [
              "# Browser Import\n\n## Chapter One\n\n### Scene One\n\nLocal-only body.",
            ],
            "browser-import.md",
            { type: "text/markdown" },
          ),
        ],
      },
    });

    await screen.findByText(/^(インポート内容|Import preview)$/);
    fireEvent.click(
      screen.getByRole("button", { name: /^(インポート|Import)$/ }),
    );
    await screen.findByText(
      /^(すべてのエントリのインポートが完了しました。|All entries imported successfully\.)$/,
    );

    const exported = await runtime.exportWorkspace();
    const persisted = await store.get(workspaceId);
    expect(persisted).toMatchObject({ revision: 1 });
    expect(persisted?.bytes).toEqual(exported);

    const restored = await createBrowserMock({ databaseBytes: exported });
    const result = await restored.invoke<{
      rows: Array<{ nodeType: string; title: string; content: string | null }>;
    }>("db_execute", {
      sql: `SELECT node_type AS nodeType, title, content
              FROM tree_nodes
             WHERE project_id = ?
             ORDER BY node_type, title`,
      params: ["default-project"],
      method: "all",
    });
    restored.close();

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeType: "folder", title: "Chapter One" }),
        expect.objectContaining({ nodeType: "scene", title: "Scene One" }),
      ]),
    );
    const scene = result.rows.find((row) => row.nodeType === "scene");
    expect(scene?.content).toContain("Local-only body.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
