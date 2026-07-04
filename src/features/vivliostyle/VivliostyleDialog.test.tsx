// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { VivliostyleDialog } from "./VivliostyleDialog";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  VIVLIOSTYLE_HTML_FILENAME,
  VIVLIOSTYLE_THEME_FILENAME,
} from "./buildVivliostyleHtml";
import type { VivliostyleBuildFile } from "./types";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    invokeMock(cmd, args),
  listen: async (event: string, handler: (payload: unknown) => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// AnimatedOverlay は motion/react + portal を含むため素通しの殻に差し替える
vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="overlay">{children}</div> : null),
}));

const NODES = [
  {
    id: "scene-1",
    parentId: null,
    nodeType: "scene",
    sortOrder: "a0",
    title: "第一話",
  },
] as unknown as TreeNodeData[];

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) =>
    selector({ nodes: NODES, expandedIds: [] }),
}));

vi.mock("@/features/codex/mentionNameResolver", () => ({
  currentCodexMentionResolver: () => undefined,
}));

const SCENE_DOC = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "吾輩は猫である。" }],
    },
  ],
});

vi.mock("./loadExportSources", () => ({
  loadVivliostyleExportSources: async () => ({
    contentMap: { "scene-1": SCENE_DOC },
    projectTitle: "テスト作品",
    projectLanguage: "ja",
  }),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emitEvent(event: string, payload: unknown) {
  for (const handler of listeners.get(event) ?? []) {
    handler(payload);
  }
}

function setupInvoke(detect: { path: string; version: string } | null) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "vivliostyle_detect":
        return detect;
      case "vivliostyle_build":
        return "run-1";
      case "vivliostyle_abort_build":
        return undefined;
      case "vivliostyle_save_output":
        return "/tmp/book.pdf";
      default:
        // settingsStore の永続化など無関係な invoke は握りつぶす
        return undefined;
    }
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("VivliostyleDialog", () => {
  it("CLI 未検出時に導入ガイドを表示し、書き出しボタンを無効化する", async () => {
    setupInvoke(null);
    render(<VivliostyleDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByTestId("vivliostyle-cli-guide"),
    ).toBeInTheDocument();
    expect(screen.getByText("npm install -g @vivliostyle/cli")).toBeVisible();
    expect(screen.getByTestId("vivliostyle-build")).toBeDisabled();
  });

  it("CLI 検出済みなら書き出しボタンが活性化する", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    expect(screen.queryByTestId("vivliostyle-cli-guide")).toBeNull();
  });

  it("書き出しで book.html と theme.css を含む files が invoke される", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("vivliostyle-build"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_build",
        expect.objectContaining({ format: "pdf", binaryPath: null }),
      );
    });
    const call = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "vivliostyle_build",
    );
    const files = (call?.[1] as { files: VivliostyleBuildFile[] }).files;
    const names = files.map((f) => f.name);
    expect(names).toContain(VIVLIOSTYLE_HTML_FILENAME);
    expect(names).toContain(VIVLIOSTYLE_THEME_FILENAME);
    const html = files.find((f) => f.name === VIVLIOSTYLE_HTML_FILENAME);
    expect(html?.contents).toContain("吾輩は猫である。");
    const css = files.find((f) => f.name === VIVLIOSTYLE_THEME_FILENAME);
    expect(css?.contents).toContain("@page");
  });

  it("done イベントで保存ボタンが現れ、save_output が invoke される", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("vivliostyle-build"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_build",
        expect.anything(),
      );
    });

    await act(async () => {
      emitEvent("vivliostyle:done", { runId: "run-1", outputToken: "tok-1" });
    });

    const saveButton = await screen.findByTestId("vivliostyle-save");
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vivliostyle_save_output", {
        outputToken: "tok-1",
      });
    });
  });

  it("error イベントでエラーメッセージを表示する", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("vivliostyle-build"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_build",
        expect.anything(),
      );
    });

    await act(async () => {
      emitEvent("vivliostyle:error", {
        runId: "run-1",
        message: "chromium launch failed",
      });
    });

    expect(await screen.findByText("chromium launch failed")).toBeVisible();
    expect(screen.queryByTestId("vivliostyle-save")).toBeNull();
  });
});
