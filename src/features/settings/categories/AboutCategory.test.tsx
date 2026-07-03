// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AboutCategory } from "./AboutCategory";
import i18n from "@/lib/i18n";

// 子コンポーネントはモック化し、規約セクションの src だけを testid で観測する。
// AppInfoHeader / LicensesSection は Tauri 依存や fetch を持つため無害化する。
vi.mock("./about/AppInfoHeader", () => ({
  AppInfoHeader: () => <div data-testid="app-info-header" />,
}));
vi.mock("./about/LicensesSection", () => ({
  LicensesSection: () => <div data-testid="licenses-section" />,
}));
vi.mock("./about/CollapsibleDocSection", () => ({
  CollapsibleDocSection: ({ src }: { src: string }) => (
    <div data-testid={`doc-section-${src}`} />
  ),
}));

beforeEach(async () => {
  // 既定=ja に戻す（他テストが日本語 UI に依存するため）。
  await i18n.changeLanguage("ja");
});

describe("AboutCategory 規約の言語出し分け", () => {
  it("ja UI では日本語規約 (TERMS_ja.md) を表示する", async () => {
    await i18n.changeLanguage("ja");
    render(<AboutCategory />);
    expect(screen.getByTestId("doc-section-TERMS_ja.md")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-section-TERMS_en.md")).toBeNull();
  });

  it("en UI では英訳規約 (TERMS_en.md) を表示する", async () => {
    await i18n.changeLanguage("en");
    render(<AboutCategory />);
    expect(screen.getByTestId("doc-section-TERMS_en.md")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-section-TERMS_ja.md")).toBeNull();
  });
});
