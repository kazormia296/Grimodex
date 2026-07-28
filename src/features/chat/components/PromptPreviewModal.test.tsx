// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PromptPreviewModal } from "./PromptPreviewModal";

// i18n は実 ja.json を解決して {{...}} 補間する軽量スタブ（実描画と同じ文言を検証する）。
vi.mock("react-i18next", async () => {
  const ja = (await import("@/locales/ja.json")).default as Record<
    string,
    unknown
  >;
  const resolve = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (o, p) =>
          o && typeof o === "object"
            ? (o as Record<string, unknown>)[p]
            : undefined,
        ja,
      );
  return {
    useTranslation: () => ({
      t: (key: string, arg?: unknown) => {
        const resolved = resolve(key);
        let text: string;
        if (typeof resolved === "string") text = resolved;
        else if (typeof arg === "string") text = arg;
        else text = (arg as { defaultValue?: string })?.defaultValue ?? key;
        if (arg && typeof arg === "object") {
          for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
            if (k !== "defaultValue")
              text = text.replaceAll(`{{${k}}}`, String(v));
          }
        }
        return text;
      },
    }),
  };
});

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

  it("exact 構築不能時は live prompt と入力を表示・保存しない", () => {
    render(
      <PromptPreviewModal
        systemPrompt="STALE LIVE ESTIMATE PROMPT"
        layers={[]}
        totalTokens={999}
        userMessage="未送信の入力"
        unavailable
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText(
        "正確なプロンプトを構築できませんでした。現在のコンテキストを確認し、プレビューを開き直してください。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("STALE LIVE ESTIMATE PROMPT"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("未送信の入力")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "テンプレート保存" }),
    ).not.toBeInTheDocument();
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
