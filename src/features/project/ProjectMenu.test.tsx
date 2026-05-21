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
    }) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        data-testid="mock-create-submit"
        onClick={() =>
          void onCreate({ title: "New", genre: "", language: "ja" })
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
});
