// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiDataConsentDialog } from "./AiDataConsentDialog";

const disclosure = {
  schemaVersion: "grimodex/ai-data-disclosure/1" as const,
  policyVersion: "2026-07-20.1",
  route: "byok" as const,
  provider: "openai",
  destination: "https://api.openai.com",
  consentId: "consent_byok_openai_2026_07_20_abcdef",
  usagePolicy: {
    summary: "選択した文脈をユーザー自身のOpenAI API契約で送信します。",
    policyUrl: "https://try.grimodex.app/privacy",
  },
  sentData: [
    { category: "prompt", description: "入力した依頼" },
    { category: "selected-context", description: "選択した本文と設定" },
  ],
  processingDestinations: [
    {
      processor: "OpenAI API",
      purpose: "AI応答の生成",
      location: "OpenAI managed infrastructure",
      privacyPolicyUrl: "https://openai.com/policies/privacy-policy/",
    },
  ],
  storage: {
    application: {
      storesPrompt: true,
      storesResponse: true,
      location: "このブラウザのローカルワークスペース（IndexedDB）",
    },
    provider: {
      summary: "Provider retains abuse-monitoring logs for up to 30 days.",
      policyUrl: "https://example.com/provider-retention",
    },
  },
  retention: {
    application: { uploadMinutes: 0, sourceDays: 0, artifactDays: 0 },
    provider: {
      summary: "Provider policy applies.",
      policyUrl: "https://example.com/provider-retention",
    },
  },
  trainingUse: {
    status: "not-used" as const,
    summary: "API入出力は既定でモデル学習に使用されません。",
    policyUrl:
      "https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/",
  },
};

describe("AiDataConsentDialog", () => {
  it("送信内容、処理・保存先、保持、学習利用と具体的なポリシー名を表示する", () => {
    render(
      <AiDataConsentDialog
        open
        disclosure={disclosure}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    expect(screen.getByText("入力した依頼")).toBeInTheDocument();
    expect(screen.getByText("OpenAI API")).toBeInTheDocument();
    expect(screen.getByText(/IndexedDB/)).toBeInTheDocument();
    expect(screen.getByText(/up to 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/モデル学習に使用されません/)).toBeInTheDocument();
    expect(screen.getByText("2026-07-20.1")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "GrimodexのAIデータ利用方針" }),
    ).toHaveAttribute("href", "https://try.grimodex.app/privacy");
    expect(
      screen.getByRole("link", { name: "OpenAI APIのプライバシーポリシー" }),
    ).toHaveAttribute("href", "https://openai.com/policies/privacy-policy/");
    expect(screen.queryByText(/^ポリシーを開く$/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Cloudflare|Hosted|Scan/i),
    ).not.toBeInTheDocument();
  });

  it("明示確認するまで同意を確定しない", () => {
    const onAccept = vi.fn();
    render(
      <AiDataConsentDialog
        open
        disclosure={disclosure}
        onAccept={onAccept}
        onDecline={vi.fn()}
      />,
    );
    const accept = screen.getByRole("button", { name: "同意してAIを使う" });
    expect(accept).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "上記の処理・送信・保存・学習利用方針を確認しました",
      }),
    );
    expect(accept).toBeEnabled();
    fireEvent.click(accept);

    expect(onAccept).toHaveBeenCalledWith(disclosure.consentId);
  });

  it("拒否時はAI送信を進めない", () => {
    const onDecline = vi.fn();
    render(
      <AiDataConsentDialog
        open
        disclosure={disclosure}
        onAccept={vi.fn()}
        onDecline={onDecline}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "今は使わない" }));
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
