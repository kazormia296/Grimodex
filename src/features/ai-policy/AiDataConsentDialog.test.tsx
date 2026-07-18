// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiDataConsentDialog } from "./AiDataConsentDialog";

const disclosure = {
  schemaVersion: "grimodex/ai-data-disclosure/1" as const,
  policyVersion: "2026-07-19.1",
  route: "hosted-editor" as const,
  provider: "workers-ai",
  consentId: "consent_opaque_server_value_0123456789",
  usagePolicy: {
    summary: "選択した文脈だけをAI補助に使います。",
    policyUrl: "https://try.grimodex.app/ai-policy",
  },
  sentData: [
    { category: "prompt", description: "入力した依頼" },
    { category: "selected-context", description: "選択した本文と設定" },
  ],
  processingDestinations: [
    {
      processor: "Cloudflare Workers AI",
      purpose: "AI応答の生成",
      location: "Cloudflare managed infrastructure",
      privacyPolicyUrl: "https://www.cloudflare.com/privacypolicy/",
    },
  ],
  storage: {
    application: {
      storesPrompt: false,
      storesResponse: true,
      location: "Cloudflare R2",
    },
    provider: {
      summary: "Provider policy applies.",
      policyUrl: "https://www.cloudflare.com/privacypolicy/",
    },
  },
  retention: {
    application: { uploadMinutes: 60, sourceDays: 1, artifactDays: 30 },
    provider: {
      summary: "Provider policy applies.",
      policyUrl: "https://www.cloudflare.com/privacypolicy/",
    },
  },
  trainingUse: {
    status: "not-used" as const,
    summary: "入出力はモデル学習に使用されません。",
    policyUrl:
      "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
  },
};

describe("AiDataConsentDialog", () => {
  it("送信内容、処理・保存先、保持、学習利用をすべて表示する", () => {
    render(
      <AiDataConsentDialog
        open
        disclosure={disclosure}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "AIへ送信する前に確認" }),
    ).toBeInTheDocument();
    expect(screen.getByText("入力した依頼")).toBeInTheDocument();
    expect(screen.getByText("選択した本文と設定")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Workers AI")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare R2")).toBeInTheDocument();
    expect(screen.getByText(/1日/)).toBeInTheDocument();
    expect(screen.getByText(/30日/)).toBeInTheDocument();
    expect(
      screen.getByText("入出力はモデル学習に使用されません。"),
    ).toBeInTheDocument();
  });

  it("全項目の確認を選ぶまで同意を確定しない", () => {
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
        name: "上記の送信・保存・学習利用方針を確認しました",
      }),
    );
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
