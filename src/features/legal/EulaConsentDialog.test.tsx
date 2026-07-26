// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EulaConsentDialog } from "./EulaConsentDialog";
import { EULA_VERSION } from "./constants";
import i18n from "@/lib/i18n";

const updateGlobalSettings = vi.fn();
let mockGlobalSettings: { acceptedEulaVersion?: string } | null = null;

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: () => ({
    globalSettings: mockGlobalSettings,
    updateGlobalSettings,
  }),
}));

vi.mock("./MarkdownDocPlaceholder", () => ({}));
vi.mock("@/features/settings/categories/about/MarkdownDoc", () => ({
  MarkdownDoc: ({ src }: { src: string }) => (
    <div data-testid={`markdown-doc-${src}`}>mock markdown: {src}</div>
  ),
}));

beforeEach(async () => {
  updateGlobalSettings.mockReset();
  updateGlobalSettings.mockResolvedValue(undefined);
  mockGlobalSettings = null;
  // 言語をテスト間でリセット（既定=ja）。他テストは日本語 UI 文言に依存する。
  await i18n.changeLanguage("ja");
});

describe("EulaConsentDialog", () => {
  it("does not render while globalSettings is loading (null)", () => {
    mockGlobalSettings = null;
    render(<EulaConsentDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not render when accepted version matches current", () => {
    mockGlobalSettings = { acceptedEulaVersion: EULA_VERSION };
    render(<EulaConsentDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders when no accepted version (legacy/new user)", () => {
    mockGlobalSettings = {};
    render(<EulaConsentDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("markdown-doc-TERMS_ja.md")).toBeInTheDocument();
  });

  it("renders when accepted version is older", () => {
    mockGlobalSettings = { acceptedEulaVersion: "0.9" };
    render(<EulaConsentDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Accept button is disabled until checkbox is checked", async () => {
    mockGlobalSettings = {};
    render(<EulaConsentDialog />);
    const acceptBtn = screen.getByRole("button", { name: /同意して開始/ });
    expect(acceptBtn).toBeDisabled();

    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);
    expect(acceptBtn).not.toBeDisabled();
  });

  it("clicking Accept calls updateGlobalSettings with current version", async () => {
    mockGlobalSettings = {};
    render(<EulaConsentDialog />);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /同意して開始/ }));
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      acceptedEulaVersion: EULA_VERSION,
    });
  });

  it("toggles developer message section", async () => {
    mockGlobalSettings = {};
    render(<EulaConsentDialog />);
    expect(
      screen.queryByTestId("markdown-doc-DEVELOPER_MESSAGE_ja.md"),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: /開発者からのメッセージを読む/ }),
    );
    expect(
      screen.getByTestId("markdown-doc-DEVELOPER_MESSAGE_ja.md"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /開発者からのメッセージを閉じる/ }),
    );
    expect(
      screen.queryByTestId("markdown-doc-DEVELOPER_MESSAGE_ja.md"),
    ).toBeNull();
  });

  it("shows Japanese terms (TERMS_ja.md) when UI language is ja", async () => {
    mockGlobalSettings = {};
    await i18n.changeLanguage("ja");
    render(<EulaConsentDialog />);
    expect(screen.getByTestId("markdown-doc-TERMS_ja.md")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-doc-TERMS_en.md")).toBeNull();
  });

  it("shows English terms (TERMS_en.md) when UI language is en", async () => {
    mockGlobalSettings = {};
    await i18n.changeLanguage("en");
    render(<EulaConsentDialog />);
    expect(screen.getByTestId("markdown-doc-TERMS_en.md")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-doc-TERMS_ja.md")).toBeNull();
  });
});
