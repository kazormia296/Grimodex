// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { VivliostyleExportSection } from "./VivliostyleExportSection";
import { resetVivliostyleRunStoreForTests } from "./runStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  VIVLIOSTYLE_HTML_FILENAME,
  VIVLIOSTYLE_THEME_FILENAME,
} from "./buildVivliostyleHtml";
import type { VivliostyleBuildFile } from "./types";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const { invokeMock, listeners, currentProjectIdRef } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  currentProjectIdRef: { value: "project-a" },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => currentProjectIdRef.value,
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
      case "vivliostyle_preview_start":
      case "vivliostyle_preview_stop":
        return undefined;
      default:
        // settingsStore の永続化など無関係な invoke は握りつぶす
        return undefined;
    }
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
  currentProjectIdRef.value = "project-a";
  // ビルド/プレビュー状態はグローバル store（タブ切替を跨いで生存）なので
  // テスト間で明示的に初期化する。
  resetVivliostyleRunStoreForTests();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("VivliostyleExportSection", () => {
  it("CLI 未検出時に導入ガイドを表示し、書き出しボタンを無効化する", async () => {
    setupInvoke(null);
    render(<VivliostyleExportSection />);

    expect(
      await screen.findByTestId("vivliostyle-cli-guide"),
    ).toBeInTheDocument();
    expect(screen.getByText("npm install -g @vivliostyle/cli")).toBeVisible();
    expect(screen.getByTestId("vivliostyle-build")).toBeDisabled();
  });

  it("CLI 検出済みなら書き出しボタンが活性化する", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    expect(screen.queryByTestId("vivliostyle-cli-guide")).toBeNull();
  });

  it("書き出しで book.html と theme.css を含む files が invoke される", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

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

  it("done イベントで save_output が自動 invoke され、保存ボタンは表示しない", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

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

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vivliostyle_save_output", {
        outputToken: "tok-1",
      });
    });
    expect(screen.queryByTestId("vivliostyle-save")).toBeNull();
  });

  it("error イベントでエラーメッセージを表示する", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

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

  it("プレビュー開始で preview_start が invoke され、停止ボタンに切り替わる", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

    const previewButton = screen.getByTestId("vivliostyle-preview");
    await waitFor(() => {
      expect(previewButton).toBeEnabled();
    });
    expect(previewButton).toHaveTextContent("vivliostyle.preview.start");
    fireEvent.click(previewButton);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_preview_start",
        expect.objectContaining({ binaryPath: null }),
      );
    });
    // files は build と同じ book.html + theme.css のスナップショット
    const call = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "vivliostyle_preview_start",
    );
    const files = (call?.[1] as { files: VivliostyleBuildFile[] }).files;
    const names = files.map((f) => f.name);
    expect(names).toContain(VIVLIOSTYLE_HTML_FILENAME);
    expect(names).toContain(VIVLIOSTYLE_THEME_FILENAME);
    expect(
      files.find((f) => f.name === VIVLIOSTYLE_HTML_FILENAME)?.contents,
    ).toContain("吾輩は猫である。");

    await waitFor(() => {
      expect(previewButton).toHaveTextContent("vivliostyle.preview.stop");
    });
  });

  it("preview-exited イベントで開始ボタンに戻る", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

    const previewButton = screen.getByTestId("vivliostyle-preview");
    await waitFor(() => {
      expect(previewButton).toBeEnabled();
    });
    fireEvent.click(previewButton);
    await waitFor(() => {
      expect(previewButton).toHaveTextContent("vivliostyle.preview.stop");
    });

    // ユーザーがプレビューウィンドウを閉じた（自然終了）
    await act(async () => {
      emitEvent("vivliostyle:preview-exited", {});
    });

    await waitFor(() => {
      expect(previewButton).toHaveTextContent("vivliostyle.preview.start");
    });
  });

  it("実行中にプレビューボタンを押すと preview_stop が invoke され idle に戻る", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

    const previewButton = screen.getByTestId("vivliostyle-preview");
    await waitFor(() => {
      expect(previewButton).toBeEnabled();
    });
    fireEvent.click(previewButton);
    await waitFor(() => {
      expect(previewButton).toHaveTextContent("vivliostyle.preview.stop");
    });

    fireEvent.click(previewButton);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_preview_stop",
        undefined,
      );
    });
    await waitFor(() => {
      expect(previewButton).toHaveTextContent("vivliostyle.preview.start");
    });
  });

  it("実行中ビルドはタブ切替（unmount→remount）後も running 表示を維持し中止できる", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    const first = render(<VivliostyleExportSection />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("vivliostyle-build"));
    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build-progress")).toBeVisible();
    });

    // 別タブへ移動して戻る（= unmount → remount）
    first.unmount();
    render(<VivliostyleExportSection />);

    // 進捗と中止ボタンが維持されている
    expect(
      await screen.findByTestId("vivliostyle-build-progress"),
    ).toBeVisible();
    fireEvent.click(screen.getByText("vivliostyle.build.abort"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vivliostyle_abort_build", {
        runId: "run-1",
      });
    });
  });

  it("タブ非表示中に done が届いても、自動保存を取りこぼさない", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    const first = render(<VivliostyleExportSection />);

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

    first.unmount();
    // タブ非表示中に完了（購読はグローバルなので取りこぼさない）
    await act(async () => {
      emitEvent("vivliostyle:done", { runId: "run-1", outputToken: "tok-1" });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vivliostyle_save_output", {
        outputToken: "tok-1",
      });
    });

    render(<VivliostyleExportSection />);
    expect(screen.queryByTestId("vivliostyle-save")).toBeNull();
  });

  it("プレビュー実行状態はタブ切替（unmount→remount）後も維持され停止できる", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    const first = render(<VivliostyleExportSection />);

    const firstPreviewButton = screen.getByTestId("vivliostyle-preview");
    await waitFor(() => {
      expect(firstPreviewButton).toBeEnabled();
    });
    fireEvent.click(firstPreviewButton);
    await waitFor(() => {
      expect(firstPreviewButton).toHaveTextContent("vivliostyle.preview.stop");
    });

    first.unmount();
    render(<VivliostyleExportSection />);

    // 停止ボタンのまま維持され、押すと preview_stop が飛ぶ
    const previewButton = screen.getByTestId("vivliostyle-preview");
    await waitFor(() => {
      expect(previewButton).toHaveTextContent("vivliostyle.preview.stop");
    });
    fireEvent.click(previewButton);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_preview_stop",
        undefined,
      );
    });
  });

  it("done 後にもう一度書き出すと running 表示に戻る（前回終端の残骸で固まらない）", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    render(<VivliostyleExportSection />);

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
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vivliostyle_save_output", {
        outputToken: "tok-1",
      });
    });

    // 2 回目の書き出し（中止ボタン = running 状態のみの UI で判定）
    fireEvent.click(screen.getByTestId("vivliostyle-build"));
    await waitFor(() => {
      expect(screen.getByText("vivliostyle.build.abort")).toBeVisible();
    });
    expect(screen.queryByTestId("vivliostyle-save")).toBeNull();
  });

  it("invoke 解決前の二度押しでは vivliostyle_build は 1 回しか飛ばない", async () => {
    let resolveBuild: ((runId: string) => void) | null = null;
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "vivliostyle_detect":
          return { path: "/usr/bin/vivliostyle", version: "8.0.0" };
        case "vivliostyle_build":
          return new Promise<string>((resolve) => {
            resolveBuild = resolve;
          });
        default:
          return undefined;
      }
    });
    render(<VivliostyleExportSection />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    // 1 回目: invoke が飛ぶが解決しない（spawn 中の窓を再現）
    fireEvent.click(screen.getByTestId("vivliostyle-build"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "vivliostyle_build",
        expect.anything(),
      );
    });
    // 2 回目: invoke 未解決の窓での二度押し
    fireEvent.click(screen.getByTestId("vivliostyle-build"));

    await act(async () => {
      resolveBuild?.("run-1");
    });
    await waitFor(() => {
      expect(screen.getByText("vivliostyle.build.abort")).toBeVisible();
    });
    const buildCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "vivliostyle_build",
    );
    expect(buildCalls).toHaveLength(1);
  });

  it("別プロジェクトで開くと前プロジェクトの done は破棄される", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    const first = render(<VivliostyleExportSection />);

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
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vivliostyle_save_output", {
        outputToken: "tok-1",
      });
    });

    // プロジェクト切替後に再マウント（別プロジェクトでタブを開いた状況）
    first.unmount();
    currentProjectIdRef.value = "project-b";
    render(<VivliostyleExportSection />);

    await waitFor(() => {
      expect(screen.getByTestId("vivliostyle-build")).toBeEnabled();
    });
    expect(screen.queryByTestId("vivliostyle-save")).toBeNull();
  });

  it("プレビュー起動失敗時はエラートーストを出し idle のまま", async () => {
    setupInvoke({ path: "/usr/bin/vivliostyle", version: "8.0.0" });
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "vivliostyle_detect":
          return { path: "/usr/bin/vivliostyle", version: "8.0.0" };
        case "vivliostyle_preview_start":
          throw new Error("spawn failed");
        default:
          return undefined;
      }
    });
    render(<VivliostyleExportSection />);

    const previewButton = screen.getByTestId("vivliostyle-preview");
    await waitFor(() => {
      expect(previewButton).toBeEnabled();
    });
    fireEvent.click(previewButton);

    const { toast } = await import("sonner");
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("vivliostyle.preview.failed");
    });
    expect(previewButton).toHaveTextContent("vivliostyle.preview.start");
  });
});
