// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { HostedEditorTrialBar } from "./HostedEditorTrialBar";

afterEach(async () => {
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
});
