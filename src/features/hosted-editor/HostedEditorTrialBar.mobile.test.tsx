// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { HostedEditorTrialBar } from "./HostedEditorTrialBar";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(async () => {
  window.sessionStorage.clear();
  await i18n.changeLanguage("ja");
});

describe("HostedEditorTrialBar phone presentation", () => {
  it("collapses the long contract into a concise mobile notice", async () => {
    await i18n.changeLanguage("ja");

    render(<HostedEditorTrialBar compact />);

    const notice = screen.getByRole("region", {
      name: "Web Editor 試用版",
    });
    expect(notice).toHaveAttribute("data-compact", "true");
    expect(screen.getByText(/このブラウザに保存/)).toHaveAttribute(
      "data-trial-mobile-summary",
    );
    expect(notice.querySelector("[data-trial-details]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("can be dismissed for the browser session without hiding desktop notice", async () => {
    await i18n.changeLanguage("ja");
    const onContinue = vi.fn();
    const { rerender } = render(
      <HostedEditorTrialBar compact onContinue={onContinue} />,
    );

    const closeButton = screen.getByRole("button", { name: "閉じる" });
    expect(closeButton.className).toContain("min-h-11");
    expect(
      screen.getByRole("button", { name: "Grimodexで続きを書く" }).className,
    ).toContain("min-h-11");

    fireEvent.click(closeButton);

    expect(
      screen.queryByRole("region", { name: "Web Editor 試用版" }),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(
        "grimodex.hosted-editor.trial-banner-dismissed",
      ),
    ).toBe("1");

    rerender(<HostedEditorTrialBar onContinue={onContinue} />);
    expect(
      screen.getByRole("region", { name: "Web Editor 試用版" }),
    ).toBeInTheDocument();
  });
});
