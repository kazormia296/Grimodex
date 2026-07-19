import { describe, expect, it, vi } from "vitest";
import { ScanApiClient } from "./scanApiClient";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ScanApiClient", () => {
  it("binds the browser fetch receiver when no fetch implementation is injected", async () => {
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(
        response({
          token: "one-time",
          expiresAt: "2026-07-19T00:05:00.000Z",
        }),
      );
    });
    vi.stubGlobal("fetch", receiverSensitiveFetch);

    try {
      const client = new ScanApiClient({
        baseUrl: "https://scan.example",
      });

      await expect(
        client.createEditorToken({
          scanId: "scan-1",
          scanToken: "scan-secret",
        }),
      ).resolves.toEqual({
        token: "one-time",
        expiresAt: "2026-07-19T00:05:00.000Z",
      });
      expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends the Turnstile token and Full entitlement only in their intended requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/uploads/") && url.endsWith("/complete"))
          return response({});
        if (url.includes("/scans") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            scanId: string;
            scanToken: string;
          };
          return response({
            scanId: body.scanId,
            scanToken: body.scanToken,
            mode: "full",
          });
        }
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
      "consent_test_scan_upload_123456",
      "en",
    );

    const intentBody = JSON.parse(String(requests[0]?.init?.body));
    expect(intentBody.turnstileToken).toBe("turnstile-token");
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-ai-consent-id": "consent_test_scan_upload_123456",
    });
    expect(requests.at(-1)?.init?.headers).toMatchObject({
      "x-upload-token": "upload-token",
      "x-scan-full-access": "full-entitlement",
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      "x-scan-source-language": "en",
    });
  });

  it("retries scan creation with an identical client-generated handle", async () => {
    const createBodies: string[] = [];
    let createAttempts = 0;
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/upload-intents")) {
          return response({
            uploadId: "upload-1",
            uploadUrl: "https://scan.example/upload-1",
            uploadToken: "upload-token",
            expiresAt: new Date().toISOString(),
          });
        }
        if (url.endsWith("/api/v1/uploads/upload-1/complete")) {
          return response({});
        }
        if (url.endsWith("/api/v1/scans") && init?.method === "POST") {
          const serialized = String(init.body);
          createBodies.push(serialized);
          createAttempts += 1;
          if (createAttempts === 1) {
            return response({ error: { message: "gateway unavailable" } }, 503);
          }
          const body = JSON.parse(serialized) as {
            scanId: string;
            scanToken: string;
          };
          return response({ ...body, mode: "quick" }, 202);
        }
        return response({});
      },
    );
    const sleep = vi.fn(async () => undefined);
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      sleep,
    });

    const handle = await client.uploadSource(
      new File(["本文"], "novel.txt", { type: "text/plain" }),
      "quick",
      "consent_test_scan_upload_123456",
    );

    expect(createBodies).toHaveLength(2);
    expect(createBodies[1]).toBe(createBodies[0]);
    const body = JSON.parse(createBodies[0]!) as {
      uploadId: string;
      mode: string;
      scanId: string;
      scanToken: string;
    };
    expect(body).toMatchObject({ uploadId: "upload-1", mode: "quick" });
    expect(body.scanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.scanToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const binaryToken = atob(
      body.scanToken.replace(/-/g, "+").replace(/_/g, "/") + "=",
    );
    expect(binaryToken).toHaveLength(32);
    expect(handle).toEqual({
      scanId: body.scanId,
      scanToken: body.scanToken,
      mode: "quick",
    });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("recovers a totally lost create response by probing the locally known handle", async () => {
    const createBodies: string[] = [];
    const statusRequests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/upload-intents")) {
          return response({
            uploadId: "upload-1",
            uploadUrl: "https://scan.example/upload-1",
            uploadToken: "upload-token",
            expiresAt: new Date().toISOString(),
          });
        }
        if (url.endsWith("/api/v1/uploads/upload-1/complete")) {
          return response({});
        }
        if (url.endsWith("/api/v1/scans") && init?.method === "POST") {
          createBodies.push(String(init.body));
          throw new TypeError("create response was lost");
        }
        if (url.includes("/api/v1/scans/") && init?.method !== "POST") {
          statusRequests.push({ url, init });
          const body = JSON.parse(createBodies[0]!) as {
            scanId: string;
          };
          return response({
            scanId: body.scanId,
            status: "queued",
            mode: "quick",
            updatedAt: new Date().toISOString(),
          });
        }
        return response({});
      },
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      sleep: async () => undefined,
    });

    const handle = await client.uploadSource(
      new File(["本文"], "novel.txt", { type: "text/plain" }),
      "quick",
      "consent_test_scan_upload_123456",
    );

    expect(createBodies).toHaveLength(3);
    expect(new Set(createBodies)).toHaveLength(1);
    const body = JSON.parse(createBodies[0]!) as {
      scanId: string;
      scanToken: string;
    };
    expect(handle).toEqual({
      scanId: body.scanId,
      scanToken: body.scanToken,
      mode: "quick",
    });
    expect(statusRequests).toHaveLength(1);
    expect(statusRequests[0]?.url).toContain(encodeURIComponent(body.scanId));
    expect(statusRequests[0]?.init?.headers).toMatchObject({
      "x-scan-token": body.scanToken,
    });
  });

  it("rejects a create response that substitutes the client-generated handle", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/upload-intents")) {
          return response({
            uploadId: "upload-1",
            uploadUrl: "https://scan.example/upload-1",
            uploadToken: "upload-token",
            expiresAt: new Date().toISOString(),
          });
        }
        if (url.endsWith("/api/v1/uploads/upload-1/complete")) {
          return response({});
        }
        if (url.endsWith("/api/v1/scans") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { scanId: string };
          return response({
            scanId: body.scanId,
            scanToken: "substituted-token",
            mode: "quick",
          });
        }
        return response({});
      },
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
      sleep: async () => undefined,
    });

    await expect(
      client.uploadSource(
        new File(["本文"], "novel.txt", { type: "text/plain" }),
        "quick",
        "consent_test_scan_upload_123456",
      ),
    ).rejects.toThrow("did not match the requested handle");
  });

  it("issues an editor token without consuming the editor seed in Scan", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/editor-tokens"))
          return response({
            token: "one-time",
            expiresAt: "2026-07-19T00:05:00.000Z",
          });
        return response({});
      },
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example/",
      fetchImpl,
    });

    await expect(
      client.createEditorToken({
        scanId: "scan/1",
        scanToken: "scan-secret",
      }),
    ).resolves.toEqual({
      token: "one-time",
      expiresAt: "2026-07-19T00:05:00.000Z",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://scan.example/api/v1/scans/scan%2F1/editor-tokens",
    );
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-scan-token": "scan-secret",
    });
    expect(requests.some(({ url }) => url.includes("/editor-seeds"))).toBe(
      false,
    );
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
