// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("PromptPreviewModal", () => {
  it("構築済みプロンプト（related_scenes 込み）を表示する", () => {
    render(
      <PromptPreviewModal
        systemPrompt="SYSTEM PROMPT with related_scenes excerpt"
        layers={[]}
        totalTokens={20}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByText("SYSTEM PROMPT with related_scenes excerpt"),
    ).toBeInTheDocument();
  });

  it("loading 中はプレースホルダを出し、本文は出さない", () => {
    render(
      <PromptPreviewModal
        systemPrompt="should not show yet"
        layers={[]}
        totalTokens={0}
        loading
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("プロンプトを構築中…")).toBeInTheDocument();
    expect(screen.queryByText("should not show yet")).not.toBeInTheDocument();
  });

  it("userMessage を渡すと送信メッセージを描画する", () => {
    render(
      <PromptPreviewModal
        systemPrompt="SYS"
        layers={[]}
        totalTokens={0}
        userMessage="これから送る入力"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("これから送る入力")).toBeInTheDocument();
  });
});
