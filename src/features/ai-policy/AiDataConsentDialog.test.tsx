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
      summary: "Provider retains abuse-monitoring logs for up to 30 days.",
      policyUrl: "https://example.com/provider-retention",
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
      screen.getByText(/abuse-monitoring logs for up to 30 days/i),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link", { name: "ポリシーを開く" })
        .some(
          (link) =>
            link.getAttribute("href") ===
            "https://example.com/provider-retention",
        ),
    ).toBe(true);
    expect(
      screen.getByText("入出力はモデル学習に使用されません。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "クラウド利用時の原稿内容と権利",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/成人向け・R18.*一律.*禁止/u)).toBeInTheDocument();
    expect(screen.getByText(/AI.*拒否/u)).toBeInTheDocument();
    expect(screen.getByText(/権利.*許諾.*二次創作/u)).toBeInTheDocument();
    expect(screen.getByText(/児童.*未成年/u)).toBeInTheDocument();
    expect(
      screen
        .getByRole("link", {
          name: "Cloudflare ホスティング／Abuse方針",
        })
        .getAttribute("href"),
    ).toBe(
      "https://blog.cloudflare.com/cloudflares-abuse-policies-and-approach/",
    );
  });

  it("Hosted Editorではデータと内容・権利の両方を確認するまで同意を確定しない", () => {
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
    expect(accept).toBeDisabled();
    fireEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /必要な権利・許諾/ }));
    expect(accept).not.toBeDisabled();
    fireEvent.click(accept);

    expect(onAccept).toHaveBeenCalledWith(disclosure.consentId);
  });

  it("デスクトップBYOK経路にはクラウド固有の内容確認を追加しない", () => {
    const onAccept = vi.fn();
    render(
      <AiDataConsentDialog
        open
        disclosure={{
          ...disclosure,
          route: "byok",
          provider: "openai",
          consentId: "consent_byok_openai_2026_07_19_abcdef",
        }}
        onAccept={onAccept}
        onDecline={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("heading", {
        name: "クラウド利用時の原稿内容と権利",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "上記の送信・保存・学習利用方針を確認しました",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "同意してAIを使う" }));

    expect(onAccept).toHaveBeenCalledWith(
      "consent_byok_openai_2026_07_19_abcdef",
    );
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
