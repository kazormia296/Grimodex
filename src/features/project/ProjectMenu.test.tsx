// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectMenu } from "./ProjectMenu";
import { useProjectStore } from "./projectStore";
import { PROJECT_ID } from "./constants";

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
  useProjectStore.setState({
    currentProjectId: PROJECT_ID,
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

describe("ProjectMenu", () => {
  it("shows current project title and lists all projects", () => {
    render(<ProjectMenu />);
    expect(screen.getByTestId("project-menu-trigger")).toHaveTextContent(
      "Novel A",
    );
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    expect(screen.getByTestId("project-switch-proj-b")).toBeInTheDocument();
  });

  it("calls loadProject when selecting another project", async () => {
    const loadProject = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ loadProject });

    render(<ProjectMenu />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-switch-proj-b"));

    await waitFor(() => {
      expect(loadProject).toHaveBeenCalledWith("proj-b");
    });
  });

  it("opens create dialog from menu", () => {
    render(<ProjectMenu />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-create-open"));
    expect(screen.getByTestId("mock-create-submit")).toBeInTheDocument();
  });

  it("calls onOpenImport when import is clicked", () => {
    const onOpenImport = vi.fn();
    render(<ProjectMenu onOpenImport={onOpenImport} />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-import-open"));
    expect(onOpenImport).toHaveBeenCalledOnce();
  });

  it("calls onOpenExport when the unified export item is clicked", () => {
    const onOpenExport = vi.fn();
    render(<ProjectMenu onOpenExport={onOpenExport} />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-export-open"));
    expect(onOpenExport).toHaveBeenCalledOnce();
  });

  it("omits the export item when onOpenExport is not provided", () => {
    render(<ProjectMenu />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    expect(screen.queryByTestId("project-export-open")).toBeNull();
  });

  // 回帰ゲート: トリガー幅・パネル幅は内容に左右されない固定幅であること。
  // (プロジェクト名やコマンドラベルの長さで揺れていた問題の再発防止)
  it("uses content-independent fixed widths for trigger and dropdown panel", () => {
    render(<ProjectMenu onOpenImport={vi.fn()} onOpenExport={vi.fn()} />);

    const trigger = screen.getByTestId("project-menu-trigger");
    expect(trigger.className).toContain("w-44");
    expect(trigger.className).toContain("justify-between");

    fireEvent.click(trigger);
    const panel = screen.getByTestId("project-menu-dropdown");
    expect(panel.className).toContain("w-72");
    expect(panel.className).not.toContain("min-w-56");

    // コマンド項目は固定幅内で折り返さない。
    expect(screen.getByTestId("project-export-open").className).toContain(
      "whitespace-nowrap",
    );
  });

  it("calls onOpenSnapshot when the snapshot item is clicked", () => {
    const onOpenSnapshot = vi.fn();
    render(<ProjectMenu onOpenSnapshot={onOpenSnapshot} />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    fireEvent.click(screen.getByTestId("project-snapshot-open"));
    expect(onOpenSnapshot).toHaveBeenCalledOnce();
  });

  it("omits the snapshot item when onOpenSnapshot is not provided", () => {
    render(<ProjectMenu />);
    fireEvent.click(screen.getByTestId("project-menu-trigger"));
    expect(screen.queryByTestId("project-snapshot-open")).toBeNull();
  });
});
