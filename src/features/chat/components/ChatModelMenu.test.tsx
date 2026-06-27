// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatModelMenu } from "./ChatModelMenu";

const baseProps = {
  sections: [],
  loading: false,
  current: { provider: undefined, modelId: "" },
  onSelect: () => {},
};

describe("ChatModelMenu height handling", () => {
  it("渡された maxHeight(px) を root に適用し、リストを内部スクロールさせる", () => {
    const { container } = render(
      <ChatModelMenu {...baseProps} maxHeight={320} />,
    );
    const root = container.firstElementChild as HTMLElement;
    // ビューポート可用高さに収まるよう root を bound する。
    expect(root.style.maxHeight).toBe("320px");
    // 検索バーは固定(shrink-0)、リスト側が min-h-0 で縮んで内部スクロールする。
    const list = root.querySelector(".overflow-y-auto");
    expect(list?.className).toContain("min-h-0");
  });

  it("maxHeight 未指定時は 60vh にフォールバックする", () => {
    const { container } = render(<ChatModelMenu {...baseProps} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.maxHeight).toBe("60vh");
  });
});

describe("ChatModelMenu inheritOption (beat ブロック用)", () => {
  it("継承行を先頭に描画し、active のときハイライトする", () => {
    const { getByTestId } = render(
      <ChatModelMenu
        {...baseProps}
        inheritOption={{
          label: "継承 (既定)",
          active: true,
          onSelect: () => {},
        }}
      />,
    );
    const row = getByTestId("model-inherit-option");
    expect(row.textContent).toContain("継承 (既定)");
    // active 時は Check アイコンが可視(opacity-100)。
    expect(row.querySelector(".opacity-100")).not.toBeNull();
  });

  it("クリックで inheritOption.onSelect が呼ばれる", async () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <ChatModelMenu
        {...baseProps}
        inheritOption={{ label: "継承", active: false, onSelect }}
      />,
    );
    await userEvent.click(getByTestId("model-inherit-option"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("inheritOption 未指定時は継承行を出さない(チャット入力欄の従来挙動)", () => {
    const { queryByTestId } = render(<ChatModelMenu {...baseProps} />);
    expect(queryByTestId("model-inherit-option")).toBeNull();
  });
});
