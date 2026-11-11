// @vitest-environment happy-dom
/**
 * ヘッダーの統合メニュー（ワークスペース＋プロジェクト）のトリガーとパネルの契約。
 * 寸法（縮み方・container query）は WorkspaceMenu.browser.test.tsx の実 Chromium で見る。
 * プロジェクトの一覧・操作の振る舞いは features/project/ProjectMenu.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useWorkspaceStore } from "./store";
import { useProjectStore } from "@/features/project/projectStore";
import { PROJECT_ID } from "@/features/project/constants";
import type { Project } from "@/features/project/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/features/project/CreateProjectDialog", () => ({
  CreateProjectDialog: () => null,
}));

vi.mock("@/lib/dialog", () => ({
  openFolderDialog: vi.fn().mockResolvedValue(null),
}));

function project(id: string, title: string): Project {
  return {
    id,
    title,
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
  } as Project;
}

function setNames(workspace: string, title: string) {
  useWorkspaceStore.setState({ activeWorkspaceName: workspace });
  useProjectStore.setState({ projects: [project(PROJECT_ID, title)] });
}

function trigger() {
  return screen.getByTestId("workspace-menu-trigger");
}

function openPanel() {
  fireEvent.click(trigger());
  return screen.getByTestId("workspace-menu-dropdown");
}

beforeEach(() => {
  useWorkspaceStore.setState({
    activeWorkspaceName: "mynovel",
    activeWorkspacePath: "/work/mynovel",
    workspaceOpenRevision: 3,
    workspaceOpenRequestInProgress: false,
    workspaceSwitchInProgress: false,
    globalSettings: {
      recentWorkspaces: [
        { path: "/work/mynovel", lastOpened: "2026-11-03T00:00:00Z" },
        { path: "/work/shorts", lastOpened: "2026-11-02T00:00:00Z" },
        { path: "/work/rewrite-copy", lastOpened: "2026-11-01T00:00:00Z" },
      ],
    } as never,
    openRecentWorkspace: vi.fn().mockResolvedValue(undefined),
    requestOpenWorkspace: vi.fn().mockResolvedValue(undefined),
    showLauncher: vi.fn(),
  });
  useProjectStore.setState({
    currentProjectId: PROJECT_ID,
    projectLoadStatus: "ready",
    degradedParticipants: [],
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    projects: [project(PROJECT_ID, "星屑の記録")],
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkspaceMenu trigger", () => {
  it("puts the folder name alone in the first span of the button, then the title", () => {
    render(<WorkspaceMenu />);
    const spans = trigger().querySelectorAll("span");
    // journey は trigger.locator("span").first().textContent() をフォルダ名と完全一致で比べる。
    expect(spans[0].textContent).toBe("mynovel");
    const title = screen.getByTestId("project-menu-trigger");
    expect(trigger()).toContainElement(title);
    expect(title.textContent).toBe("星屑の記録");
    expect(trigger()).toHaveAttribute("data-tour-target", "project-menu");
    expect(trigger().parentElement).toHaveAttribute(
      "data-tour-target",
      "workspace-menu",
    );
    expect(trigger()).toHaveAttribute("data-workspace-open-revision", "3");
  });

  it("keeps the folder span first and exact while degraded", () => {
    useProjectStore.setState({
      projectLoadStatus: "degraded",
      degradedParticipants: ["last-active-project"],
    });
    render(<WorkspaceMenu />);
    expect(trigger().querySelector("span")?.textContent).toBe("mynovel");
    expect(trigger()).toHaveAttribute(
      "aria-label",
      "mynovel / 星屑の記録: project.loadDegraded",
    );
    // 「!」は ▾ の手前。
    const spans = Array.from(trigger().querySelectorAll("span"));
    expect(spans.map((span) => span.textContent).slice(-2)).toEqual(["!", "▾"]);
  });

  it("labels the trigger with the full 'folder / title' text", () => {
    render(<WorkspaceMenu />);
    expect(trigger()).toHaveAttribute("aria-label", "mynovel / 星屑の記録");
    expect(trigger()).toHaveAttribute("title", "mynovel / 星屑の記録");
    // パネルは role=menu ではないので aria-haspopup は付けない。
    expect(trigger()).not.toHaveAttribute("aria-haspopup");
  });

  it("uses the fallbacks when no workspace or project is known", () => {
    useWorkspaceStore.setState({ activeWorkspaceName: null });
    useProjectStore.setState({ projects: [], currentProjectId: "missing" });
    render(<WorkspaceMenu />);
    expect(trigger().querySelector("span")?.textContent).toBe(
      "workspaceMenu.fallback",
    );
    expect(screen.getByTestId("project-menu-trigger").textContent).toBe(
      "project.menu.fallback",
    );
  });

  it("hides the folder name and slash (but keeps them in the DOM) when the title matches", () => {
    setNames("Untitled", "Untitled");
    render(<WorkspaceMenu />);
    const [folder, slash] = Array.from(trigger().querySelectorAll("span"));
    expect(folder.textContent).toBe("Untitled");
    expect(folder).toHaveClass("hidden");
    expect(slash.textContent).toBe("/");
    expect(slash).toHaveClass("hidden");
    expect(screen.getByTestId("project-menu-trigger")).not.toHaveClass(
      "hidden",
    );
  });

  it("hides the folder name only through the header-menu container query otherwise", () => {
    render(<WorkspaceMenu />);
    const [folder, slash] = Array.from(trigger().querySelectorAll("span"));
    expect(folder).not.toHaveClass("hidden");
    expect(folder).toHaveClass("@max-[288px]/header-menu:hidden");
    expect(slash).toHaveClass("@max-[288px]/header-menu:hidden");
    expect(screen.getByTestId("project-menu-trigger").className).not.toContain(
      "header-menu",
    );
  });

  it("clips the names inside the trigger instead of overflowing onto neighbours", () => {
    render(<WorkspaceMenu />);
    expect(trigger()).toHaveClass("overflow-hidden", "max-w-full", "min-w-0");
  });

  it("lets the folder name shrink first, with minimum widths only for longer names", () => {
    setNames("mynovel", "星屑の記録");
    const { unmount } = render(<WorkspaceMenu />);
    let [folder] = Array.from(trigger().querySelectorAll("span"));
    expect(folder).toHaveClass("min-w-[3.5em]", "shrink-[1000]", "truncate");
    expect(screen.getByTestId("project-menu-trigger")).toHaveClass(
      "min-w-[1.5em]",
      "truncate",
    );
    unmount();

    // 3 文字以下のフォルダ名・2 文字以下の題名は、省略する幅も無いので縮めない。
    setNames("短編集", "番外");
    render(<WorkspaceMenu />);
    [folder] = Array.from(trigger().querySelectorAll("span"));
    expect(folder).toHaveClass("shrink-0");
    expect(folder).not.toHaveClass("min-w-[3.5em]");
    const title = screen.getByTestId("project-menu-trigger");
    expect(title).toHaveClass("shrink-0");
    expect(title).not.toHaveClass("min-w-[1.5em]");
  });

  it("reflects the open state in aria-expanded and points aria-controls at the panel", () => {
    render(<WorkspaceMenu />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-controls");
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByTestId("workspace-menu-dropdown");
    expect(panel.id).not.toBe("");
    expect(trigger()).toHaveAttribute("aria-controls", panel.id);
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-controls");
    expect(screen.queryByTestId("workspace-menu-dropdown")).toBeNull();
  });

  it("disables the whole trigger while a workspace open or switch is in progress", () => {
    useWorkspaceStore.setState({ workspaceSwitchInProgress: true });
    const { unmount } = render(<WorkspaceMenu />);
    expect(trigger()).toBeDisabled();
    unmount();

    useWorkspaceStore.setState({
      workspaceSwitchInProgress: false,
      workspaceOpenRequestInProgress: true,
    });
    render(<WorkspaceMenu />);
    expect(trigger()).toBeDisabled();
  });
});

describe("WorkspaceMenu panel", () => {
  it("excludes the panel from the Electron window drag region", () => {
    render(<WorkspaceMenu />);
    const panel = openPanel();
    expect(panel).toHaveAttribute("data-tauri-drag-region", "false");
    expect(panel).toHaveClass("w-80", "max-h-[calc(100vh-4rem)]");
  });

  it("groups this workspace's projects and the other workspaces", () => {
    render(<WorkspaceMenu />);
    const panel = openPanel();
    const current = within(panel).getByRole("group", {
      name: "mynovel workspaceMenu.currentSection",
    });
    expect(
      within(current).getByTestId(`project-switch-${PROJECT_ID}`),
    ).toBeInTheDocument();
    expect(within(current).getByTestId("project-create-open")).toBeTruthy();
    const other = within(panel).getByRole("group", {
      name: "workspaceMenu.otherSection",
    });
    expect(
      within(other).getByRole("button", { name: "shorts" }),
    ).toBeInTheDocument();
  });

  // name の文字列指定は完全一致（journey の exact: true と同じ判定）。
  it("names recent workspace rows by the folder name only", () => {
    render(<WorkspaceMenu />);
    const panel = openPanel();
    const row = within(panel).getByRole("button", {
      name: "rewrite-copy",
    });
    expect(row).toHaveAttribute("title", "/work/rewrite-copy");
    // 現在のワークスペースは「最近」に出さない。
    expect(within(panel).queryByRole("button", { name: "mynovel" })).toBeNull();
  });

  it("offers a single 'Open Folder…' item, described by the create hint", () => {
    render(<WorkspaceMenu />);
    const panel = openPanel();
    const items = within(panel).getAllByText("workspaceMenu.openOther");
    expect(items).toHaveLength(1);
    expect(within(panel).queryByText("workspaceMenu.newWorkspace")).toBeNull();
    const openFolder = within(panel).getByRole("button", {
      name: "workspaceMenu.openOther",
    });
    expect(openFolder).toHaveAccessibleDescription(
      "workspaceMenu.openFolderHint",
    );
  });

  it("has no Web Editor handoff item", () => {
    render(<WorkspaceMenu onOpenImport={vi.fn()} onOpenExport={vi.fn()} />);
    const panel = openPanel();
    expect(screen.queryByTestId("web-editor-handoff-open")).toBeNull();
    expect(
      within(panel).queryByText("hostedEditor.desktopImport.action"),
    ).toBeNull();
  });

  it("omits the command block and its divider when no command is provided", () => {
    const { unmount } = render(<WorkspaceMenu />);
    const bare = openPanel().querySelectorAll(".border-t").length;
    unmount();
    render(<WorkspaceMenu onOpenSnapshot={vi.fn()} />);
    const withCommands = openPanel().querySelectorAll(".border-t").length;
    expect(withCommands).toBe(bare + 1);
  });

  it("closes on Escape, returns focus to the trigger, and consumes the key", () => {
    const documentEscape = vi.fn();
    document.addEventListener("keydown", documentEscape);
    try {
      render(<WorkspaceMenu />);
      openPanel();
      const item = screen.getByTestId(`project-switch-${PROJECT_ID}`);
      item.focus();
      const notPrevented = fireEvent.keyDown(item, { key: "Escape" });
      expect(notPrevented).toBe(false);
      expect(documentEscape).not.toHaveBeenCalled();
      expect(screen.queryByTestId("workspace-menu-dropdown")).toBeNull();
      expect(trigger()).toHaveFocus();
    } finally {
      document.removeEventListener("keydown", documentEscape);
    }
  });

  it("leaves Escape alone while the menu is closed", () => {
    render(<WorkspaceMenu />);
    trigger().focus();
    expect(fireEvent.keyDown(trigger(), { key: "Escape" })).toBe(true);
  });

  it("moves through the enabled items with the arrow, Home and End keys", () => {
    render(<WorkspaceMenu onOpenSnapshot={vi.fn()} />);
    trigger().focus();
    // ↓ でトリガーから開いて、最初の項目へ。
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const first = screen.getByTestId(`project-switch-${PROJECT_ID}`);
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByTestId("project-create-open")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByTestId("project-snapshot-open")).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(
      screen.getByRole("button", { name: "workspaceMenu.startScreen" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(
      screen.getByRole("button", { name: "workspaceMenu.startScreen" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(first).toHaveFocus();
  });

  it("moves symmetrically past the row delete buttons, which stay reachable with Tab", () => {
    useProjectStore.setState({
      projects: [
        project(PROJECT_ID, "星屑の記録"),
        project("proj-b", "番外編"),
        project("proj-c", "改稿"),
      ],
    });
    render(<WorkspaceMenu />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const a = screen.getByTestId(`project-switch-${PROJECT_ID}`);
    const b = screen.getByTestId("project-switch-proj-b");
    const c = screen.getByTestId("project-switch-proj-c");
    expect(a).toHaveFocus();
    // ↓↓ と ↑↑ は同じ行を逆にたどる（削除ボタンには止まらない）。
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c, { key: "ArrowUp" });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b, { key: "ArrowUp" });
    expect(a).toHaveFocus();
    // 削除は行の兄弟の button のまま、Tab の順序に残る（data-menu-secondary）。
    const deleteB = screen.getByTestId("project-delete-proj-b");
    expect(deleteB.tagName).toBe("BUTTON");
    expect(deleteB).toHaveAttribute("data-menu-secondary");
    expect(deleteB).not.toHaveAttribute("tabindex");
    expect(deleteB.className).toContain("group-focus-within:inline");
    expect(b.nextElementSibling).toBe(deleteB);
    // 削除ボタンに focus があるときは、DOM の順で前後の行の項目へ動く。
    deleteB.focus();
    fireEvent.keyDown(deleteB, { key: "ArrowDown" });
    expect(c).toHaveFocus();
    deleteB.focus();
    fireEvent.keyDown(deleteB, { key: "ArrowUp" });
    expect(b).toHaveFocus();
  });

  it("skips disabled items while a workspace switch is running", () => {
    render(<WorkspaceMenu />);
    openPanel();
    act(() => {
      useWorkspaceStore.setState({ workspaceSwitchInProgress: true });
    });
    const first = screen.getByTestId(`project-switch-${PROJECT_ID}`);
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    // 「別のワークスペース」の項目は disabled。最後の有効な項目は「新規プロジェクト…」。
    expect(screen.getByTestId("project-create-open")).toHaveFocus();
  });

  it("closes on an outside mousedown without moving focus to the trigger", () => {
    render(
      <>
        <button type="button">outside</button>
        <WorkspaceMenu />
      </>,
    );
    openPanel();
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    fireEvent.mouseDown(outside);
    expect(screen.queryByTestId("workspace-menu-dropdown")).toBeNull();
    expect(outside).toHaveFocus();
  });

  it("opens recent workspaces and the start screen through the workspace store", () => {
    render(<WorkspaceMenu />);
    fireEvent.click(
      within(openPanel()).getByRole("button", { name: "shorts" }),
    );
    expect(
      useWorkspaceStore.getState().openRecentWorkspace,
    ).toHaveBeenCalledWith("/work/shorts", "workspace-menu-recent");
    expect(screen.queryByTestId("workspace-menu-dropdown")).toBeNull();

    fireEvent.click(
      within(openPanel()).getByRole("button", {
        name: "workspaceMenu.startScreen",
      }),
    );
    expect(useWorkspaceStore.getState().showLauncher).toHaveBeenCalledOnce();
  });
});
