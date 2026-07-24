// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { PhoneWorkspaceChrome } from "./PhoneWorkspaceChrome";
import { useCompactNavigationStore } from "./compactNavigationStore";

describe("PhoneWorkspaceChrome", () => {
  beforeEach(async () => {
    useCompactNavigationStore.getState().reset();
    await i18n.changeLanguage("ja");
  });

  afterEach(() => {
    cleanup();
    useCompactNavigationStore.getState().reset();
  });

  it("uses localized navigation, a real scene title, and a meaningful back stack", () => {
    render(<PhoneWorkspaceChrome active sceneTitle="導入" />);

    expect(
      screen.getByRole("navigation", { name: "ワークスペース" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "執筆" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("導入")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "戻る" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "シーン" }));

    expect(screen.getByRole("button", { name: "シーン" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "シーン" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));

    expect(screen.getByRole("button", { name: "執筆" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("導入")).toBeInTheDocument();
  });
});
