// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EditorBodyWithLoading,
  EditorContentSkeleton,
} from "./EditorContentSkeleton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("EditorContentSkeleton", () => {
  it("renders loading skeleton with accessible label", () => {
    render(<EditorContentSkeleton />);
    expect(screen.getByTestId("editor-content-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("EditorBodyWithLoading", () => {
  it("shows skeleton overlay while loading", () => {
    render(
      <EditorBodyWithLoading isLoading>
        <div data-testid="editor-body">content</div>
      </EditorBodyWithLoading>,
    );
    expect(screen.getByTestId("editor-content-loading")).toBeInTheDocument();
    expect(screen.getByTestId("editor-body").parentElement).toHaveClass(
      "invisible",
    );
  });

  it("hides skeleton when not loading", () => {
    render(
      <EditorBodyWithLoading isLoading={false}>
        <div data-testid="editor-body">content</div>
      </EditorBodyWithLoading>,
    );
    expect(
      screen.queryByTestId("editor-content-loading"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-body").parentElement).not.toHaveClass(
      "invisible",
    );
  });
});
