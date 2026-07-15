import { describe, expect, it, vi } from "vitest";
import { ScanApiClient } from "./scanApiClient";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ScanApiClient", () => {
  it("sends the Turnstile token and Full entitlement only in their intended requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/uploads/") && url.endsWith("/complete"))
          return response({});
        if (url.includes("/scans") && init?.method === "POST")
          return response({
            scanId: "scan-1",
            scanToken: "scan-token",
            mode: "full",
          });
        if (url.includes("/upload-intents"))
          return response({
            uploadId: "upload-1",
            uploadUrl: "https://scan.example/upload-1",
            uploadToken: "upload-token",
            expiresAt: new Date().toISOString(),
          });
        return response({});
      },
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      turnstileToken: "turnstile-token",
      fullAccessToken: "full-entitlement",
    });

    await client.uploadSource(
      new File(["本文"], "novel.txt", { type: "text/plain" }),
      "full",
    );

    const intentBody = JSON.parse(String(requests[0]?.init?.body));
    expect(intentBody.turnstileToken).toBe("turnstile-token");
    expect(requests.at(-1)?.init?.headers).toMatchObject({
      "x-upload-token": "upload-token",
      "x-scan-full-access": "full-entitlement",
    });
  });

  it("keeps upload and scan tokens in headers and never in editor seed URLs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/editor-tokens"))
          return response({ token: "one-time" });
        if (url.endsWith("/api/v1/editor-seeds"))
          return response({ schemaVersion: "seed" });
        return response({});
      },
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example/",
      fetchImpl,
    });

    await client.getEditorSeed({ scanId: "scan/1", scanToken: "scan-secret" });

    expect(requests[0]?.url).toBe(
      "https://scan.example/api/v1/scans/scan%2F1/editor-tokens",
    );
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-scan-token": "scan-secret",
    });
    expect(requests[1]?.url).toBe("https://scan.example/api/v1/editor-seeds");
    expect(requests[1]?.url).not.toContain("one-time");
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: "Bearer one-time",
    });
  });

  it("polls at two seconds then backs off to at most five seconds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return response({
        scanId: "scan-1",
        status: calls < 3 ? "extracting" : "completed",
        mode: "quick",
        updatedAt: new Date().toISOString(),
      });
    });
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await expect(
      client.waitForCompletion({ scanId: "scan-1", scanToken: "token" }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(delays).toEqual([2000, 2500]);
  });

  it("retries transient status failures without losing the polling deadline", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1)
        return response({ error: { message: "gateway down" } }, 503);
      return response({
        scanId: "scan-1",
        status: "completed",
        mode: "quick",
        updatedAt: new Date().toISOString(),
      });
    });
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await expect(
      client.waitForCompletion({ scanId: "scan-1", scanToken: "token" }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
  });

  it("does not retry a non-transient authorization failure", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { message: "unauthorized" } }, 401),
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      sleep: vi.fn(),
    });

    await expect(
      client.waitForCompletion({ scanId: "scan-1", scanToken: "token" }),
    ).rejects.toThrow("unauthorized");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
