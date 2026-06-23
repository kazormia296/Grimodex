// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
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
