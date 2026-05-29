// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateProjectDialog } from "./CreateProjectDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn().mockResolvedValue([
    { id: "t1", slug: "character", label: "Characters" },
    { id: "t2", slug: "location", label: "Locations" },
  ]),
}));

const sampleProjects = [
  {
    id: "proj-a",
    title: "Novel A",
    genre: null,
    pov: null,
    tense: null,
    language: "ja",
    styleGuide: null,
    aiInstructions: null,
    outline: null,
    phaseResolutionMode: "auto" as const,
    aiPolicy: "{}",
    createdAt: "",
    updatedAt: "",
  },
];

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onCreate with form values", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateProjectDialog
        open
        onClose={() => {}}
        projects={sampleProjects}
        defaultSourceProjectId="proj-a"
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByTestId("project-title-input"), {
      target: { value: "Volume 2" },
    });
    fireEvent.change(screen.getByTestId("project-genre-select"), {
      target: { value: "Fantasy" },
    });
    fireEvent.change(screen.getByTestId("project-language-select"), {
      target: { value: "en" },
    });
    fireEvent.click(screen.getByTestId("project-create-submit"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Volume 2",
        genre: "Fantasy",
        language: "en",
        timelapseEnabled: true,
        seedFromProjectId: undefined,
        seedTypeSlugs: [],
      });
    });
  });

  it("includes selected codex types in onCreate payload", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateProjectDialog
        open
        onClose={() => {}}
        projects={sampleProjects}
        defaultSourceProjectId="proj-a"
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByTestId("project-title-input"), {
      target: { value: "Volume 2" },
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("project-seed-type-character"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("project-seed-type-character"));
    fireEvent.click(screen.getByTestId("project-create-submit"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Volume 2",
        genre: "",
        language: "ja",
        timelapseEnabled: true,
        seedFromProjectId: "proj-a",
        seedTypeSlugs: ["character"],
      });
    });
  });

  it("disables submit when title is empty", () => {
    render(
      <CreateProjectDialog
        open
        onClose={() => {}}
        projects={sampleProjects}
        defaultSourceProjectId="proj-a"
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
  });

  it("passes timelapseEnabled=false when the checkbox is unchecked", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateProjectDialog
        open
        onClose={() => {}}
        projects={sampleProjects}
        defaultSourceProjectId="proj-a"
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByTestId("project-title-input"), {
      target: { value: "No Lapse" },
    });
    fireEvent.click(screen.getByTestId("project-timelapse-checkbox"));
    fireEvent.click(screen.getByTestId("project-create-submit"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No Lapse", timelapseEnabled: false }),
      );
    });
  });
});
