import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AiDataDisclosureV1 } from "@grimodex/scan-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanApiClient } from "../api/scanApiClient";
import { ScanWebApp } from "./ScanWebApp";
import { SCAN_LOCALE_STORAGE_KEY } from "../i18n/scanLocale";

const disclosure: AiDataDisclosureV1 = {
  schemaVersion: "grimodex/ai-data-disclosure/1",
  policyVersion: "2026-07-19.1",
  route: "scan",
  provider: "workers-ai",
  consentId: "consent_scan_workers_ai_2026_07_19_abcdef",
  usagePolicy: {
    summary: "明示的な同意後にのみ原稿を処理します。",
    policyUrl: "https://example.com/policy",
  },
  sentData: [{ category: "source", description: "アップロードした原稿" }],
  processingDestinations: [
    {
      processor: "Cloudflare Workers AI",
      purpose: "原稿の解析",
      location: "Cloudflare managed infrastructure",
      privacyPolicyUrl: "https://example.com/privacy",
    },
  ],
  storage: {
    application: {
      storesPrompt: true,
      storesResponse: true,
      location: "Cloudflare R2 and D1",
    },
    provider: {
      summary: "Provider policy applies.",
      policyUrl: "https://example.com/provider",
    },
  },
  retention: {
    application: { uploadMinutes: 60, sourceDays: 1, artifactDays: 30 },
    provider: {
      summary: "Provider retention policy applies.",
      policyUrl: "https://example.com/retention",
    },
  },
  trainingUse: {
    status: "not-used",
    summary: "モデル学習には利用しません。",
    policyUrl: "https://example.com/training",
  },
};

function configureHostedApi(): void {
  vi.stubEnv("VITE_SCAN_API_BASE_URL", "https://scan.example");
  vi.stubEnv("VITE_SCAN_TURNSTILE_REQUIRED", "false");
}

async function acceptUploadConsent(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, {
    target: {
      files: [new File(["本文"], "story.txt", { type: "text/plain" })],
    },
  });
  await screen.findByRole("dialog", {
    name: "原稿をアップロードする前に確認",
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /送信・保存・学習利用方針/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "同意してScanを開始" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
});

function forceJapaneseUi(): void {
  localStorage.setItem(SCAN_LOCALE_STORAGE_KEY, "ja");
}

describe("ScanWebApp report ownership", () => {
  it("shows a ready state without presenting the fixture when an API is configured", () => {
    forceJapaneseUi();
    configureHostedApi();

    render(<ScanWebApp />);

    expect(
      screen.getByRole("heading", { name: "原稿をアップロードしてください" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("scan-report")).toBeNull();
    expect(screen.queryByText("灯台の手紙")).toBeNull();
  });

  it("labels the fixture as a demo inside the report when no API is configured", () => {
    forceJapaneseUi();
    vi.stubEnv("VITE_SCAN_API_BASE_URL", "");

    render(<ScanWebApp />);

    const report = screen.getByTestId("scan-report");
    expect(report.textContent).toContain("Grimodex Scan · デモレポート");
    expect(report.textContent).toContain("灯台の手紙");
  });

  it("replaces the ready state with an explicit running state", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    vi.spyOn(ScanApiClient.prototype, "uploadSource").mockImplementation(
      () => new Promise(() => undefined),
    );

    render(<ScanWebApp />);
    await acceptUploadConsent();

    expect(
      await screen.findByRole("heading", { name: "原稿を解析しています…" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("scan-report")).toBeNull();
    expect(screen.queryByText("灯台の手紙")).toBeNull();
  });

  it("shows an error state instead of the fixture when a replacement scan fails", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    vi.spyOn(ScanApiClient.prototype, "uploadSource").mockRejectedValue(
      new Error("upload failed"),
    );

    render(<ScanWebApp />);
    await acceptUploadConsent();

    expect(
      await screen.findByRole("heading", {
        name: "Scanを完了できませんでした",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("scan-report")).toBeNull();
    expect(screen.queryByText("灯台の手紙")).toBeNull();
  });

  it("switches the complete Scan interface to English and persists the choice", () => {
    forceJapaneseUi();
    configureHostedApi();
    render(<ScanWebApp />);

    fireEvent.change(screen.getByRole("combobox", { name: "表示言語" }), {
      target: { value: "en" },
    });

    expect(
      screen.getByRole("heading", { name: "Upload your manuscript" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Interface language" }),
    ).toBeTruthy();
    expect(localStorage.getItem(SCAN_LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("passes a manual manuscript language override into the upload boundary", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    const upload = vi
      .spyOn(ScanApiClient.prototype, "uploadSource")
      .mockImplementation(() => new Promise(() => undefined));
    render(<ScanWebApp />);

    fireEvent.change(screen.getByRole("combobox", { name: "執筆言語" }), {
      target: { value: "en" },
    });
    await acceptUploadConsent();

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "story.txt" }),
      "quick",
      disclosure.consentId,
      "en",
    );
  });
});
