import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanApiClient } from "../api/scanApiClient";
import { SCAN_LOCALE_STORAGE_KEY } from "../i18n/scanLocale";
import { ScanWebApp } from "./ScanWebApp";
import { writeScanOwnership } from "./scanOwnershipStorage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
});

describe("Scan account gate", () => {
  it("keeps cloud upload disabled until the Access session is verified", async () => {
    localStorage.setItem(SCAN_LOCALE_STORAGE_KEY, "ja");
    vi.stubEnv("VITE_SCAN_API_BASE_URL", "https://api.grimodex.app");
    vi.stubEnv("VITE_SCAN_AUTH_REQUIRED", "true");
    vi.stubEnv("VITE_SCAN_TURNSTILE_REQUIRED", "false");
    let resolveSession!: (value: {
      schemaVersion: "grimodex/access-session/1";
      subject: string;
      expiresAt: string;
      fullScanEnabled: boolean;
      hostedEditorAiEnabled: boolean;
    }) => void;
    vi.spyOn(ScanApiClient.prototype, "getAccountSession").mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    render(<ScanWebApp />);

    expect(screen.getByLabelText(".txt / .md をアップロード")).toBeDisabled();
    expect(screen.getByRole("link", { name: "ログイン" })).toHaveAttribute(
      "href",
      expect.stringContaining("/api/v1/session?return_to="),
    );

    resolveSession({
      schemaVersion: "grimodex/access-session/1",
      subject: "access-subject-123",
      expiresAt: "2026-07-20T00:00:00.000Z",
      fullScanEnabled: true,
      hostedEditorAiEnabled: true,
    });

    await waitFor(() =>
      expect(
        screen.getByLabelText(".txt / .md をアップロード"),
      ).not.toBeDisabled(),
    );
    expect(screen.getByRole("link", { name: "ログアウト" })).toHaveAttribute(
      "href",
      "https://api.grimodex.app/cdn-cgi/access/logout",
    );
    expect(screen.getByRole("option", { name: "Full" })).toBeTruthy();
  });

  it("does not let a different account's retained handle lock uploads", async () => {
    localStorage.setItem(SCAN_LOCALE_STORAGE_KEY, "ja");
    vi.stubEnv("VITE_SCAN_API_BASE_URL", "https://api.grimodex.app");
    vi.stubEnv("VITE_SCAN_AUTH_REQUIRED", "true");
    vi.stubEnv("VITE_SCAN_TURNSTILE_REQUIRED", "false");
    writeScanOwnership(
      sessionStorage,
      {
        scanId: "scan-owned-by-a",
        scanToken: "secret-owned-by-a",
        mode: "quick",
      },
      "access-subject-a",
    );
    vi.spyOn(ScanApiClient.prototype, "getAccountSession").mockResolvedValue({
      schemaVersion: "grimodex/access-session/1",
      subject: "access-subject-b",
      expiresAt: "2026-07-20T00:00:00.000Z",
      fullScanEnabled: false,
      hostedEditorAiEnabled: true,
    });

    render(<ScanWebApp />);

    await waitFor(() =>
      expect(
        screen.getByLabelText(".txt / .md をアップロード"),
      ).not.toBeDisabled(),
    );
    expect(
      screen.queryByRole("heading", { name: "前回のScanデータが残っています" }),
    ).toBeNull();
  });

  it("reconciles the retained handle when the active subject changes", async () => {
    localStorage.setItem(SCAN_LOCALE_STORAGE_KEY, "ja");
    vi.stubEnv("VITE_SCAN_API_BASE_URL", "https://api-a.grimodex.app");
    vi.stubEnv("VITE_SCAN_AUTH_REQUIRED", "true");
    vi.stubEnv("VITE_SCAN_TURNSTILE_REQUIRED", "false");
    writeScanOwnership(
      sessionStorage,
      {
        scanId: "scan-owned-by-a",
        scanToken: "secret-owned-by-a",
        mode: "quick",
      },
      "access-subject-a",
    );
    vi.spyOn(ScanApiClient.prototype, "getAccountSession")
      .mockResolvedValueOnce({
        schemaVersion: "grimodex/access-session/1",
        subject: "access-subject-a",
        expiresAt: "2026-07-20T00:00:00.000Z",
        fullScanEnabled: false,
        hostedEditorAiEnabled: true,
      })
      .mockResolvedValueOnce({
        schemaVersion: "grimodex/access-session/1",
        subject: "access-subject-b",
        expiresAt: "2026-07-20T01:00:00.000Z",
        fullScanEnabled: false,
        hostedEditorAiEnabled: true,
      });

    const view = render(<ScanWebApp />);
    expect(
      await screen.findByRole("heading", {
        name: "前回のScanデータが残っています",
      }),
    ).toBeTruthy();
    expect(screen.getByLabelText(".txt / .md をアップロード")).toBeDisabled();

    vi.stubEnv("VITE_SCAN_API_BASE_URL", "https://api-b.grimodex.app");
    view.rerender(<ScanWebApp />);

    await waitFor(() =>
      expect(
        screen.getByLabelText(".txt / .md をアップロード"),
      ).not.toBeDisabled(),
    );
    expect(
      screen.queryByRole("heading", { name: "前回のScanデータが残っています" }),
    ).toBeNull();
  });
});
