// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("./CodexQuickSection", () => ({
  CodexQuickSection: () => <div data-testid="codex-section-stub">codex</div>,
}));

const relatedEnabledSpy = vi.fn();
vi.mock("@/features/related-scenes/RelatedScenesSection", () => ({
  RelatedScenesSection: (props: { enabled?: boolean }) => {
    relatedEnabledSpy(props.enabled);
    return <div data-testid="related-stub">related</div>;
  },
}));

import { SceneContextPanel } from "./SceneContextPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SceneContextPanel", () => {
  it("Codex と関連シーンの両セクションを描画する", () => {
    render(<SceneContextPanel isActive />);
    expect(screen.getByTestId("codex-section-stub")).toBeTruthy();
    expect(screen.getByTestId("related-stub")).toBeTruthy();
  });

  it("isActive を RelatedScenesSection の enabled に渡す (keepalive)", () => {
    render(<SceneContextPanel isActive={false} />);
    expect(relatedEnabledSpy).toHaveBeenCalledWith(false);
  });

  it("Codex セクションに sort select があり、折りたたむと中身が消える", () => {
    render(<SceneContextPanel isActive />);
    // Codex セクションの sort select
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByTestId("codex-section-stub")).toBeTruthy();

    // Codex 見出し (関連シーンはモックなので展開ボタンは Codex のみ) を折りたたむ
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByTestId("codex-section-stub")).toBeNull();
    // 関連シーンセクションは折りたたみの影響を受けない
    expect(screen.getByTestId("related-stub")).toBeTruthy();
  });
});
