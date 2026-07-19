import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AiDataDisclosureV1 } from "@grimodex/scan-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScanApiClient,
  type ScanDeleteResponse,
  type ScanHandle,
} from "../api/scanApiClient";
import { createMinimalJaBundle } from "../fixtures/minimalJa";
import { ScanWebApp } from "./ScanWebApp";
import { SCAN_LOCALE_STORAGE_KEY } from "../i18n/scanLocale";
import { readScanOwnership, writeScanOwnership } from "./scanOwnershipStorage";

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

const ownedScanHandle: ScanHandle = {
  scanId: "scan-delete-1",
  scanToken: "scan-delete-secret",
  mode: "quick",
};

const completedStatus = {
  scanId: ownedScanHandle.scanId,
  status: "completed" as const,
  mode: "quick" as const,
  updatedAt: "2026-07-19T00:05:00.000Z",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  sessionStorage.clear();
});

function forceJapaneseUi(): void {
  localStorage.setItem(SCAN_LOCALE_STORAGE_KEY, "ja");
}

describe("ScanWebApp report ownership", () => {
  it("uses the canonical Grimodex wordmark in the Scan header", () => {
    forceJapaneseUi();
    configureHostedApi();

    render(<ScanWebApp />);

    const brand = screen.getByRole("link", { name: "Grimodex Scan" });
    const logo = brand.querySelector('svg[aria-label="Grimodex"]');
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute("viewBox")).toBe("0 0 47.95644 8.269779");
    expect(
      brand.querySelector('img[src="/icons/grimodex-scan.svg"]'),
    ).toBeNull();
    expect(within(brand).getByText("Scan")).toBeTruthy();
  });

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

  it("re-reads browser languages when a manual language returns to automatic", async () => {
    forceJapaneseUi();
    configureHostedApi();
    const languages = vi
      .spyOn(window.navigator, "languages", "get")
      .mockReturnValue(["ja-JP"]);
    render(<ScanWebApp />);

    languages.mockReturnValue(["en-US"]);
    fireEvent.change(screen.getByRole("combobox", { name: "表示言語" }), {
      target: { value: "auto" },
    });

    expect(
      await screen.findByRole("heading", { name: "Upload your manuscript" }),
    ).toBeTruthy();
    expect(localStorage.getItem(SCAN_LOCALE_STORAGE_KEY)).toBe("auto");
  });

  it("does not mix a stale disclosure into the newly selected UI language", async () => {
    forceJapaneseUi();
    configureHostedApi();
    let resolveJapanese: ((value: AiDataDisclosureV1) => void) | undefined;
    const japaneseDisclosure = {
      ...disclosure,
      usagePolicy: {
        ...disclosure.usagePolicy,
        summary: "古い日本語の開示です。",
      },
    };
    const englishDisclosure = {
      ...disclosure,
      usagePolicy: {
        ...disclosure.usagePolicy,
        summary: "Current English disclosure.",
      },
    };
    const getDisclosure = vi
      .spyOn(ScanApiClient.prototype, "getAiDisclosure")
      .mockImplementation((_route, requestedLocale) => {
        if (requestedLocale === "ja") {
          return new Promise((resolve) => {
            resolveJapanese = resolve;
          });
        }
        return Promise.resolve(englishDisclosure);
      });
    render(<ScanWebApp />);

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File(["本文"], "story.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() =>
      expect(getDisclosure).toHaveBeenCalledWith("scan", "ja"),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "表示言語" }), {
      target: { value: "en" },
    });
    await screen.findByRole("dialog", { name: "Review before uploading" });
    expect(screen.getByText("Current English disclosure.")).toBeTruthy();

    resolveJapanese?.(japaneseDisclosure);
    await Promise.resolve();
    expect(screen.queryByText("古い日本語の開示です。")).toBeNull();
    expect(getDisclosure).toHaveBeenCalledWith("scan", "en");
  });

  it("shows a stable Japanese message instead of a raw network error", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockRejectedValue(
      new TypeError("Failed to fetch raw upstream text"),
    );
    render(<ScanWebApp />);

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File(["本文"], "story.txt", { type: "text/plain" })],
      },
    });

    expect(
      await screen.findAllByText(
        "Scanサービスと通信できませんでした。接続を確認して、もう一度お試しください。",
      ),
    ).toHaveLength(2);
    expect(screen.queryByText(/Failed to fetch raw upstream text/)).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "表示言語" }), {
      target: { value: "en" },
    });
    expect(
      screen.getAllByText(
        "Scan could not connect to the service. Check your connection and try again.",
      ),
    ).toHaveLength(2);
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

  it("deletes a completed Scan after explicit confirmation and resets to Ready", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    vi.spyOn(ScanApiClient.prototype, "uploadSource").mockResolvedValue(
      ownedScanHandle,
    );
    vi.spyOn(ScanApiClient.prototype, "waitForCompletion").mockResolvedValue(
      completedStatus,
    );
    vi.spyOn(ScanApiClient.prototype, "getReport").mockResolvedValue(
      createMinimalJaBundle(),
    );
    const deletion = deferred<ScanDeleteResponse>();
    const deleteScan = vi
      .spyOn(ScanApiClient.prototype, "delete")
      .mockReturnValue(deletion.promise);

    render(<ScanWebApp />);
    await acceptUploadConsent();
    await screen.findByRole("heading", { name: "灯台の手紙" });

    fireEvent.click(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "原稿とScanデータを削除しますか？",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(deleteScan).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "原稿とScanデータを削除",
      }),
    );
    await waitFor(() =>
      expect(deleteScan).toHaveBeenCalledWith(ownedScanHandle),
    );
    expect(screen.getByRole("button", { name: "削除中…" })).toBeDisabled();
    expect(
      document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled,
    ).toBe(true);

    await act(async () => {
      deletion.resolve({
        scanId: ownedScanHandle.scanId,
        status: "deleted",
        cleanup: "completed",
      });
      await deletion.promise;
    });

    expect(
      await screen.findByRole("heading", {
        name: "原稿をアップロードしてください",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "原稿とScanデータを削除しました。公開レポートと今後のEditor引き継ぎも利用できません。",
    );
    expect(screen.queryByTestId("scan-report")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "原稿とScanデータを削除" }),
    ).toBeNull();
  });

  it("restores deletion ownership after reload and blocks replacement until deletion", async () => {
    forceJapaneseUi();
    configureHostedApi();
    writeScanOwnership(sessionStorage, ownedScanHandle);
    const deleteScan = vi
      .spyOn(ScanApiClient.prototype, "delete")
      .mockResolvedValue({
        scanId: ownedScanHandle.scanId,
        status: "deleted",
        cleanup: "completed",
      });

    render(<ScanWebApp />);

    expect(
      screen.getByRole("heading", { name: "前回のScanデータが残っています" }),
    ).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>('input[type="file"]'),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "原稿とScanデータを削除",
      }),
    );

    await waitFor(() =>
      expect(deleteScan).toHaveBeenCalledWith(ownedScanHandle),
    );
    await screen.findByRole("heading", {
      name: "原稿をアップロードしてください",
    });
    expect(readScanOwnership(sessionStorage)).toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('input[type="file"]'),
    ).not.toBeDisabled();
  });

  it("allows deletion while Scan is running and ignores the stale completion", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    vi.spyOn(ScanApiClient.prototype, "uploadSource").mockResolvedValue(
      ownedScanHandle,
    );
    const completion = deferred<typeof completedStatus>();
    vi.spyOn(ScanApiClient.prototype, "waitForCompletion").mockReturnValue(
      completion.promise,
    );
    const getReport = vi
      .spyOn(ScanApiClient.prototype, "getReport")
      .mockResolvedValue(createMinimalJaBundle());
    const deleteScan = vi
      .spyOn(ScanApiClient.prototype, "delete")
      .mockResolvedValue({
        scanId: ownedScanHandle.scanId,
        status: "deleted",
        cleanup: "pending",
      });

    render(<ScanWebApp />);
    await acceptUploadConsent();
    const deleteButton = await screen.findByRole("button", {
      name: "原稿とScanデータを削除",
    });
    expect(
      screen.getByRole("heading", { name: "原稿を解析しています…" }),
    ).toBeTruthy();

    fireEvent.click(deleteButton);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "原稿とScanデータを削除",
      }),
    );
    expect(deleteScan).toHaveBeenCalledWith(ownedScanHandle);
    expect(
      await screen.findByRole("heading", {
        name: "原稿をアップロードしてください",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "削除を受け付けました。アクセスは停止済みです。保存ファイルの削除はバックグラウンドで継続します。",
    );

    await act(async () => {
      completion.resolve(completedStatus);
      await completion.promise;
    });
    expect(getReport).not.toHaveBeenCalled();
    expect(screen.queryByTestId("scan-report")).toBeNull();
  });

  it("retains deletion access after Scan processing fails", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    vi.spyOn(ScanApiClient.prototype, "uploadSource").mockResolvedValue(
      ownedScanHandle,
    );
    vi.spyOn(ScanApiClient.prototype, "waitForCompletion").mockRejectedValue(
      new Error("poll failed"),
    );
    const deleteScan = vi
      .spyOn(ScanApiClient.prototype, "delete")
      .mockResolvedValue({
        scanId: ownedScanHandle.scanId,
        status: "deleted",
        cleanup: "completed",
      });

    render(<ScanWebApp />);
    await acceptUploadConsent();
    expect(
      await screen.findByRole("heading", {
        name: "Scanを完了できませんでした",
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "原稿とScanデータを削除",
      }),
    );
    await waitFor(() =>
      expect(deleteScan).toHaveBeenCalledWith(ownedScanHandle),
    );
    expect(
      await screen.findByRole("heading", {
        name: "原稿をアップロードしてください",
      }),
    ).toBeTruthy();
  });

  it("keeps the report and allows retry when deletion cannot be confirmed", async () => {
    forceJapaneseUi();
    configureHostedApi();
    vi.spyOn(ScanApiClient.prototype, "getAiDisclosure").mockResolvedValue(
      disclosure,
    );
    vi.spyOn(ScanApiClient.prototype, "uploadSource").mockResolvedValue(
      ownedScanHandle,
    );
    vi.spyOn(ScanApiClient.prototype, "waitForCompletion").mockResolvedValue(
      completedStatus,
    );
    vi.spyOn(ScanApiClient.prototype, "getReport").mockResolvedValue(
      createMinimalJaBundle(),
    );
    const deleteScan = vi
      .spyOn(ScanApiClient.prototype, "delete")
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce({
        scanId: ownedScanHandle.scanId,
        status: "deleted",
        cleanup: "completed",
      });

    render(<ScanWebApp />);
    await acceptUploadConsent();
    await screen.findByRole("heading", { name: "灯台の手紙" });
    fireEvent.click(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "原稿とScanデータを削除",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "削除結果を確認できませんでした。アクセスが停止していない可能性があります。接続を確認して、もう一度お試しください。",
    );
    expect(screen.getByTestId("scan-report")).toBeTruthy();
    const retry = within(screen.getByRole("dialog")).getByRole("button", {
      name: "原稿とScanデータを削除",
    });
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);

    await waitFor(() => expect(deleteScan).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("heading", {
        name: "原稿をアップロードしてください",
      }),
    ).toBeTruthy();
  });
});
