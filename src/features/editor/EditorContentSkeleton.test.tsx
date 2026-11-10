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

describe("EditorBodyWithLoading の読み終わり", () => {
  function renderLoading(now: { value: number }) {
    vi.spyOn(performance, "now").mockImplementation(() => now.value);
    return render(
      <EditorBodyWithLoading isLoading>
        <div data-testid="editor-body">content</div>
      </EditorBodyWithLoading>,
    );
  }

  it("読み込み中の線は opacity 0 から始め、要素と testid はすぐに置く", () => {
    const now = { value: 1000 };
    renderLoading(now);
    const skeleton = screen.getByTestId("editor-content-loading");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.style.opacity).toBe("0");
    vi.restoreAllMocks();
  });

  it("線が出る前に読み終えたら、写しを出さずに本文をすぐ見せる", () => {
    const now = { value: 1000 };
    const view = renderLoading(now);
    now.value = 1050;
    view.rerender(
      <EditorBodyWithLoading isLoading={false}>
        <div data-testid="editor-body">content</div>
      </EditorBodyWithLoading>,
    );
    expect(screen.queryByTestId("editor-content-loading")).toBeNull();
    expect(
      view.container.querySelector("[data-editor-loading-fade]"),
    ).toBeNull();
    vi.restoreAllMocks();
  });

  it("線が見えてから読み終えたら、testid はすぐに外し、aria-hidden の写しで消す", () => {
    const now = { value: 1000 };
    const view = renderLoading(now);
    now.value = 1300;
    view.rerender(
      <EditorBodyWithLoading isLoading={false}>
        <div data-testid="editor-body">content</div>
      </EditorBodyWithLoading>,
    );
    // E2E と smoke は testid の detach を待つ。写しは testid も aria-busy も持たない。
    expect(screen.queryByTestId("editor-content-loading")).toBeNull();
    const fade = view.container.querySelector("[data-editor-loading-fade]");
    expect(fade).not.toBeNull();
    expect(fade).toHaveAttribute("aria-hidden", "true");
    expect(fade!.querySelector("[aria-busy]")).toBeNull();
    expect(screen.getByTestId("editor-body").parentElement).not.toHaveClass(
      "invisible",
    );
    vi.restoreAllMocks();
  });
});
