// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useProjectStore } from "./projectStore";
import { PROJECT_ID } from "./constants";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { toast } from "sonner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { title?: string }) =>
      opts?.title ? `${key}:${opts.title}` : key,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("./CreateProjectDialog", () => ({
  CreateProjectDialog: ({
    open,
    onCreate,
  }: {
    open: boolean;
    onCreate: (data: {
      title: string;
      genre: string;
      language: string;
      seedFromProjectId?: string;
      seedTypeSlugs: string[];
    }) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        data-testid="mock-create-submit"
        onClick={() =>
          void onCreate({
            title: "New",
            genre: "",
            language: "ja",
            seedTypeSlugs: [],
          })
        }
      >
        mock create
      </button>
    ) : null,
}));

beforeEach(() => {
  useWorkspaceStore.setState({
    activeWorkspaceName: "mynovel",
    activeWorkspacePath: "/work/mynovel",
    workspaceOpenRequestInProgress: false,
    workspaceSwitchInProgress: false,
  });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  useProjectStore.setState({
    currentProjectId: PROJECT_ID,
    projectLoadStatus: "ready",
    degradedParticipants: [],
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    projects: [
      {
        id: PROJECT_ID,
        title: "Novel A",
        genre: null,
        pov: null,
        tense: null,
        language: "ja",
        styleGuide: null,
        aiInstructions: null,
        outline: null,
        targetReaders: null,
        phaseResolutionMode: "auto",
        aiPolicy:
          '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}',
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "proj-b",
        title: "Novel B",
        genre: null,
        pov: null,
        tense: null,
        language: "ja",
        styleGuide: null,
        aiInstructions: null,
        outline: null,
        targetReaders: null,
        phaseResolutionMode: "auto",
        aiPolicy:
          '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}',
        createdAt: "",
        updatedAt: "",
      },
    ],
  });
});

// プロジェクトの一覧・操作は、ヘッダーの統合メニュー（WorkspaceMenu）の
// 「このワークスペース」の区画と中段にある。ここではその振る舞いを固定する。
describe("ProjectMenu (in the unified WorkspaceMenu)", () => {
  it("shows current project title and lists all projects", () => {
    render(<WorkspaceMenu />);
    expect(screen.getByTestId("project-menu-trigger")).toHaveTextContent(
      "Novel A",
    );
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    expect(screen.getByTestId("project-switch-proj-b")).toBeInTheDocument();
    expect(screen.getByTestId(`project-switch-${PROJECT_ID}`)).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("project-switch-proj-b")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("opens the panel when the title span itself is clicked (journey path)", () => {
    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    expect(screen.getByTestId("workspace-menu-dropdown")).toBeInTheDocument();
    expect(screen.getByTestId("project-switch-proj-b")).toBeInTheDocument();
  });

  it("loads the Project list on mount, while the menu is still closed", () => {
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ refreshProjects });
    render(<WorkspaceMenu />);
    expect(screen.queryByTestId("workspace-menu-dropdown")).toBeNull();
    expect(refreshProjects).toHaveBeenCalledOnce();
  });

  it("calls loadProject when selecting another project", async () => {
    const loadProject = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ loadProject });

    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-switch-proj-b"));

    await waitFor(() => {
      expect(loadProject).toHaveBeenCalledWith("proj-b");
    });
  });

  it("keeps degraded Project state visible and offers a retry", async () => {
    const loadProject = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      loadProject,
      projectLoadStatus: "degraded",
      degradedParticipants: ["plot-threads-load", "last-active-project"],
    });

    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    expect(screen.getByTestId("project-load-degraded")).toHaveTextContent(
      "project.loadDegraded",
    );
    fireEvent.click(screen.getByText("common.retry"));

    await waitFor(() => {
      expect(loadProject).toHaveBeenCalledWith(PROJECT_ID);
    });
  });

  it("terminates a rejected degraded retry with the existing switch failure toast", async () => {
    const loadProject = vi
      .fn()
      .mockRejectedValue(new Error("retry load unavailable"));
    useProjectStore.setState({
      loadProject,
      projectLoadStatus: "degraded",
      degradedParticipants: ["last-active-project"],
    });

    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByText("common.retry"));

    await waitFor(() => {
      expect(loadProject).toHaveBeenCalledWith(PROJECT_ID);
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });

  it("opens create dialog from menu", () => {
    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-create-open"));
    expect(screen.getByTestId("mock-create-submit")).toBeInTheDocument();
  });

  it("calls onOpenImport when import is clicked", () => {
    const onOpenImport = vi.fn();
    render(<WorkspaceMenu onOpenImport={onOpenImport} />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-import-open"));
    expect(onOpenImport).toHaveBeenCalledOnce();
  });

  it("calls onOpenExport when the unified export item is clicked", () => {
    const onOpenExport = vi.fn();
    render(<WorkspaceMenu onOpenExport={onOpenExport} />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-export-open"));
    expect(onOpenExport).toHaveBeenCalledOnce();
  });

  it("omits the export item when onOpenExport is not provided", () => {
    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    expect(screen.queryByTestId("project-export-open")).toBeNull();
  });

  // 回帰ゲート: パネル幅は内容に左右されない固定幅であること。
  // (プロジェクト名やコマンドラベルの長さで揺れていた問題の再発防止。618051bd)
  // 統合メニューのトリガーは「フォルダ名 / 題名」を中身の幅で出し、上限 320px
  // （max-w-80）で抑える。旧プロジェクトメニューの 176px 固定（w-44）はやめた。
  it("keeps a content-independent panel width and caps the content-sized trigger", () => {
    render(<WorkspaceMenu onOpenImport={vi.fn()} onOpenExport={vi.fn()} />);

    const trigger = screen.getByTestId("workspace-menu-trigger");
    expect(trigger.className).not.toMatch(/(^|\s)w-\d/);
    expect(trigger.parentElement?.className).toContain("max-w-80");
    expect(trigger.parentElement?.className).not.toMatch(/(^|\s)w-\d/);

    fireEvent.click(trigger);
    const panel = screen.getByTestId("workspace-menu-dropdown");
    expect(panel.className).toContain("w-80");
    expect(panel.className).not.toContain("min-w-56");

    // コマンド項目は固定幅内で折り返さない。
    expect(screen.getByTestId("project-export-open").className).toContain(
      "whitespace-nowrap",
    );
  });

  it("calls onOpenSnapshot when the snapshot item is clicked", () => {
    const onOpenSnapshot = vi.fn();
    render(<WorkspaceMenu onOpenSnapshot={onOpenSnapshot} />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-snapshot-open"));
    expect(onOpenSnapshot).toHaveBeenCalledOnce();
  });

  it("omits the snapshot item when onOpenSnapshot is not provided", () => {
    render(<WorkspaceMenu />);
    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    expect(screen.queryByTestId("project-snapshot-open")).toBeNull();
  });

  it("uses a focus-managed, safe-area alert dialog for phone deletion", async () => {
    render(
      <WorkspaceViewportProvider profile="phone">
        <WorkspaceMenu />
      </WorkspaceViewportProvider>,
    );

    // 削除の確認を閉じたら、統合メニューのトリガー（button）へ focus を戻す。
    const trigger = screen.getByTestId("workspace-menu-trigger");
    fireEvent.click(trigger);
    trigger.focus();
    fireEvent.click(screen.getByTestId("project-delete-proj-b"));

    const dialog = await screen.findByRole("alertdialog", {
      name: "project.delete.confirmTitle",
    });
    expect(dialog).toHaveAccessibleDescription(
      "project.delete.confirmBody:Novel B",
    );
    expect(dialog.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(dialog.className).toContain("overflow-y-auto");
    expect(dialog.className).toContain(
      "pl-[max(1rem,env(safe-area-inset-left))]",
    );
    expect(screen.getByRole("button", { name: "common.cancel" })).toHaveClass(
      "min-h-11",
    );
    expect(
      screen.getByRole("button", { name: "common.deleteConfirm" }),
    ).toHaveClass("min-h-11");

    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });
});
