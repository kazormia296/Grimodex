// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { filterCodexOptions, CodexEntryPicker } from "./CodexEntryPicker";

describe("filterCodexOptions", () => {
  const opts = [
    { id: "1", name: "アリス" },
    { id: "2", name: "ボブ" },
    { id: "3", name: "Alice Smith" },
  ];
  it("空クエリは全件", () => {
    expect(filterCodexOptions(opts, "")).toHaveLength(3);
    expect(filterCodexOptions(opts, "  ")).toHaveLength(3);
  });
  it("名前の部分一致・大文字小文字無視", () => {
    expect(filterCodexOptions(opts, "alice").map((o) => o.id)).toEqual(["3"]);
    expect(filterCodexOptions(opts, "アリス").map((o) => o.id)).toEqual(["1"]);
  });
  it("該当なしは空", () => {
    expect(filterCodexOptions(opts, "zzz")).toHaveLength(0);
  });
});

describe("CodexEntryPicker trigger", () => {
  const opts = [{ id: "c1", name: "アリス" }];
  it("選択中は名前、未選択は『なし』を表示", () => {
    const { getByLabelText, rerender } = render(
      <CodexEntryPicker
        value="c1"
        options={opts}
        onChange={vi.fn()}
        ariaLabel="主人物"
      />,
    );
    expect(getByLabelText("主人物").textContent).toContain("アリス");
    rerender(
      <CodexEntryPicker
        value={null}
        options={opts}
        onChange={vi.fn()}
        ariaLabel="主人物"
      />,
    );
    expect(getByLabelText("主人物").textContent).toContain("なし");
  });
});
