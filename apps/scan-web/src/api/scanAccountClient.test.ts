import { describe, expect, it, vi } from "vitest";
import {
  ScanApiClient,
  ScanAuthenticationRequiredError,
} from "./scanApiClient";

describe("Scan account client", () => {
  it("loads an Access session with cross-origin credentials enabled", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        schemaVersion: "grimodex/access-session/1",
        subject: "access-subject-123",
        expiresAt: "2026-07-20T00:00:00.000Z",
        fullScanEnabled: true,
        hostedEditorAiEnabled: true,
      }),
    );
    const client = new ScanApiClient({
      baseUrl: "https://api.grimodex.app",
      fetchImpl,
    });

    await expect(client.getAccountSession()).resolves.toMatchObject({
      subject: "access-subject-123",
      fullScanEnabled: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.grimodex.app/api/v1/session",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("treats an Access login HTML response as authentication-required", async () => {
    const client = new ScanApiClient({
      baseUrl: "https://api.grimodex.app",
      fetchImpl: vi.fn(
        async () =>
          new Response("<!doctype html><title>Cloudflare Access</title>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    });

    await expect(client.getAccountSession()).rejects.toBeInstanceOf(
      ScanAuthenticationRequiredError,
    );
    expect(
      client.accountLoginUrl("https://scan.grimodex.app/?language=ja"),
    ).toBe(
      "https://api.grimodex.app/api/v1/session?return_to=https%3A%2F%2Fscan.grimodex.app%2F%3Flanguage%3Dja",
    );
    expect(client.accountLogoutUrl()).toBe(
      "https://api.grimodex.app/cdn-cgi/access/logout",
    );
  });
});
