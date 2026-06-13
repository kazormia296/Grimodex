// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PromptPreviewModal } from "./PromptPreviewModal";

// i18n は defaultValue を返す薄いスタブ（キー解決に依存しない）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, arg?: unknown) =>
      typeof arg === "string"
        ? arg
        : ((arg as { defaultValue?: string })?.defaultValue ?? _key),
  }),
}));

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("PromptPreviewModal: ライブ/前回送信 切替", () => {
  it("未送信のときはトグルを出さずライブのみ表示", () => {
    render(
      <PromptPreviewModal
        systemPrompt="LIVE PROMPT"
        layers={[]}
        totalTokens={0}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("LIVE PROMPT")).toBeInTheDocument();
    expect(screen.queryByText("前回送信")).not.toBeInTheDocument();
  });

  it("送信スナップショットがあるとトグルが出て、前回送信に related_scenes を表示できる", () => {
    render(
      <PromptPreviewModal
        systemPrompt="LIVE PROMPT (no related_scenes)"
        layers={[]}
        totalTokens={10}
        sentSystemPrompt="SENT PROMPT with related_scenes excerpt"
        sentLayers={[]}
        sentTokens={20}
        onClose={() => {}}
      />,
    );

    // 既定はライブ
    expect(
      screen.getByText("LIVE PROMPT (no related_scenes)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("SENT PROMPT with related_scenes excerpt"),
    ).not.toBeInTheDocument();

    // 前回送信へ切替
    fireEvent.click(screen.getByText("前回送信"));
    expect(
      screen.getByText("SENT PROMPT with related_scenes excerpt"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("LIVE PROMPT (no related_scenes)"),
    ).not.toBeInTheDocument();
  });
});
