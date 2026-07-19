// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { HostedEditorTrialBar } from "./HostedEditorTrialBar";

afterEach(async () => {
  await i18n.changeLanguage("ja");
});

describe("HostedEditorTrialBar", () => {
  it("explains the Scan entry in Japanese", async () => {
    await i18n.changeLanguage("ja");

    render(<HostedEditorTrialBar entryMode="scan" />);

    expect(screen.getByText(/Web Editor.*試用版/)).toBeInTheDocument();
    expect(screen.getByText(/Scan.*文書.*編集/)).toBeInTheDocument();
    expect(screen.getByText(/このブラウザに保存/)).toBeInTheDocument();
    expect(
      screen.getByText(/ローカル版Grimodex.*自動同期されません/),
    ).toBeInTheDocument();
  });

  it("explains the standalone trial in Japanese", async () => {
    await i18n.changeLanguage("ja");

    render(<HostedEditorTrialBar entryMode="standalone" />);

    expect(screen.getByText(/Web Editor.*試用版/)).toBeInTheDocument();
    expect(screen.getByText(/Web Editor.*単体.*試/)).toBeInTheDocument();
    expect(screen.getByText(/このブラウザに保存/)).toBeInTheDocument();
    expect(
      screen.getByText(/ローカル版Grimodex.*自動同期されません/),
    ).toBeInTheDocument();
  });

  it("explains the Scan entry in English", async () => {
    await i18n.changeLanguage("en");

    render(<HostedEditorTrialBar entryMode="scan" />);

    expect(screen.getByText(/Web Editor Trial/i)).toBeInTheDocument();
    expect(
      screen.getByText(/document imported.*Scan/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/stored in this browser/i)).toBeInTheDocument();
    expect(
      screen.getByText(/not automatically synced.*local Grimodex/i),
    ).toBeInTheDocument();
  });

  it("explains the standalone trial in English", async () => {
    await i18n.changeLanguage("en");

    render(<HostedEditorTrialBar entryMode="standalone" />);

    expect(screen.getByText(/Web Editor Trial/i)).toBeInTheDocument();
    expect(screen.getByText(/Web Editor.*on its own/i)).toBeInTheDocument();
    expect(screen.getByText(/stored in this browser/i)).toBeInTheDocument();
    expect(
      screen.getByText(/not automatically synced.*local Grimodex/i),
    ).toBeInTheDocument();
  });
});
