// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./WebEditorSettingsDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
    className,
    testId,
  }: {
    open: boolean;
    children: React.ReactNode;
    className?: string;
    testId?: string;
  }) =>
    open ? (
      <div className={className} data-testid={testId}>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: () => ({
    loadAll: vi.fn(),
    flushPending: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/features/settings/categories/ProjectCategory", () => ({
  ProjectCategory: () => <div>project settings</div>,
}));
vi.mock("@/features/settings/categories/EditorCategory", () => ({
  EditorCategory: () => <div>editor settings</div>,
}));
vi.mock("@/features/settings/categories/DisplayCategory", () => ({
  DisplayCategory: () => <div>display settings</div>,
}));
vi.mock("@/features/settings/categories/AboutCategory", () => ({
  AboutCategory: () => <div>about settings</div>,
}));
vi.mock("./WebEditorAiCategory", () => ({
  WebEditorAiCategory: () => <div>AI settings</div>,
}));

describe("WebEditorSettingsDialog responsive layout", () => {
  it("uses the full viewport and horizontal category navigation on phone", () => {
    render(<SettingsDialog open onClose={vi.fn()} phoneWorkspace />);

    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(dialog.className).toContain("w-screen");
    expect(dialog.className).toContain("min-w-0");
    expect(dialog.className).not.toContain("min-w-[480px]");
    expect(dialog.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(dialog.className).toContain("pr-[env(safe-area-inset-right)]");
    expect(dialog.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(dialog.className).toContain("pl-[env(safe-area-inset-left)]");

    const nav = screen.getByRole("navigation", {
      name: "app.settingsLabel",
    });
    expect(nav).toHaveAttribute("data-phone-category-nav", "true");
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).not.toContain("flex-col");
    expect(
      screen.getByRole("button", {
        name: "hostedEditor.settings.categories.project",
      }).className,
    ).toContain("whitespace-nowrap");

    const content = screen.getByTestId("settings-content");
    expect(content.className).toContain("@container");
    expect(content.className).toContain("overflow-x-hidden");
  });

  it("retains the bounded dialog and vertical navigation on desktop", () => {
    render(<SettingsDialog open onClose={vi.fn()} />);

    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.className).toContain("h-[600px]");
    expect(dialog.className).toContain("min-w-[480px]");
    expect(dialog.className).not.toContain("safe-area-inset");

    const nav = screen.getByRole("navigation", {
      name: "app.settingsLabel",
    });
    expect(nav).not.toHaveAttribute("data-phone-category-nav");
    expect(nav.className).toContain("w-[120px]");
    expect(nav.className).toContain("flex-col");
  });
});
