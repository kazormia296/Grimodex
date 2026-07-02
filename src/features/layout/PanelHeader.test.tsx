// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelHeader } from "./PanelHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("PanelHeader", () => {
  it("renders the canonical panel icon, title and data-panel-header attr", () => {
    const { container } = render(<PanelHeader panelId="chronicle" />);
    const header = container.querySelector("[data-panel-header]");
    expect(header).not.toBeNull();
    // 既定タイトルは layout.panel.<id> から解決。
    expect(screen.getByText("layout.panel.chronicle")).toBeTruthy();
    // PANEL_ICON_MAP のアイコンが svg として描画される。
    expect(header!.querySelector("svg")).not.toBeNull();
  });

  it("applies the compact standard height (h-8) and border", () => {
    const { container } = render(<PanelHeader panelId="codex" />);
    const header = container.querySelector(
      "[data-panel-header]",
    ) as HTMLElement;
    expect(header.className).toContain("h-8");
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("px-3");
    expect(header.className).toContain("text-xs");
  });

  it("exposes the title as a level-2 heading for SR navigation", () => {
    render(<PanelHeader panelId="chronicle" />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("layout.panel.chronicle");
  });

  it("keeps the heading role on custom title overrides", () => {
    render(<PanelHeader panelId="grid" title="カスタム" />);
    expect(
      screen.getByRole("heading", { level: 2, name: "カスタム" }),
    ).toBeTruthy();
  });

  it("renders count, custom title override and right-aligned actions", () => {
    render(
      <PanelHeader
        panelId="grid"
        title="カスタム"
        count="12 件"
        actions={<button type="button">act</button>}
      />,
    );
    expect(screen.getByText("カスタム")).toBeTruthy();
    expect(screen.getByText("12 件")).toBeTruthy();
    expect(screen.getByRole("button", { name: "act" })).toBeTruthy();
    // 既定タイトル(i18nキー)は出ない(override されている)。
    expect(screen.queryByText("layout.panel.grid")).toBeNull();
  });
});
