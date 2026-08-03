// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { HostedEditorTrialBar } from "./HostedEditorTrialBar";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(async () => {
  window.sessionStorage.clear();
  await i18n.changeLanguage("ja");
});

describe("Web Editor trial notice", () => {
  it("states in Japanese that AI is not included and requires a user-owned HTTP route", async () => {
    await i18n.changeLanguage("ja");

    const { container } = render(<HostedEditorTrialBar />);

    expect(screen.getByText(/Web Editor.*試用版/)).toBeInTheDocument();
    expect(screen.getByText(/本体.*エディター.*試/)).toBeInTheDocument();
    expect(screen.getByText(/このブラウザに保存/)).toBeInTheDocument();
    expect(
      screen.getByText(/ローカルファイル.*ブラウザ内/),
    ).toBeInTheDocument();
    expect(screen.getByText(/AI.*付属していません/)).toBeInTheDocument();
    expect(
      screen.getByText(/対応するHTTPプロバイダー.*APIキー.*接続先/),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent(
      /Scan|アップロード|Hosted AI|Cloudflare/i,
    );
  });

  it("states the same editor-only contract in English", async () => {
    await i18n.changeLanguage("en");

    const { container } = render(<HostedEditorTrialBar />);

    expect(screen.getByText(/Web Editor Trial/i)).toBeInTheDocument();
    expect(screen.getByText(/real Grimodex editor/i)).toBeInTheDocument();
    expect(screen.getByText(/stored in this browser/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Local files.*only in this browser/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/AI is not included/i)).toBeInTheDocument();
    expect(
      screen.getByText(/supported HTTP provider.*own API key or endpoint/i),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent(
      /Scan|upload|Hosted AI|Cloudflare/i,
    );
  });

  it("can be dismissed for the browser session on desktop", async () => {
    await i18n.changeLanguage("ja");
    const { rerender } = render(<HostedEditorTrialBar />);

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

    expect(
      screen.queryByRole("region", { name: "Web Editor 試用版" }),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(
        "grimodex.hosted-editor.trial-banner-dismissed",
      ),
    ).toBe("1");

    rerender(<HostedEditorTrialBar />);
    expect(
      screen.queryByRole("region", { name: "Web Editor 試用版" }),
    ).toBeNull();
  });
});
