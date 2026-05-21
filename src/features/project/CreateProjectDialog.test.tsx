// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateProjectDialog } from "./CreateProjectDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("CreateProjectDialog", () => {
  it("calls onCreate with form values", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateProjectDialog open onClose={() => {}} onCreate={onCreate} />);

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
      });
    });
  });

  it("disables submit when title is empty", () => {
    render(<CreateProjectDialog open onClose={() => {}} onCreate={vi.fn()} />);
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
  });
});
