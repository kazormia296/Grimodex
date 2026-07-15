import { describe, expect, it } from "vitest";
import { handleRequest } from "./router";
import type { ScanEnv } from "./env";

function env(overrides: Partial<ScanEnv> = {}): ScanEnv {
  return {
    DB: {
      prepare: () => {
        throw new Error("database should not be touched by this test");
      },
      batch: async () => [],
    },
    SCAN_BUCKET: {
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
      delete: async () => undefined,
    },
    ...overrides,
  };
}

describe("scan worker router", () => {
  it("serves a content-free health response and limits CORS to the configured origin", async () => {
    const request = new Request("https://scan.example/api/v1/health", {
      headers: { origin: "https://try.grimodex.app" },
    });
    const response = await handleRequest(request, env());
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://try.grimodex.app",
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      acceptingNewJobs: false,
    });
  });

  it("does not issue upload intents while the kill switch is off", async () => {
    const request = new Request("https://scan.example/api/v1/upload-intents", {
      method: "POST",
      body: JSON.stringify({
        filename: "novel.txt",
        contentType: "text/plain",
        size: 5,
      }),
      headers: { "content-type": "application/json" },
    });
    const response = await handleRequest(request, env());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scan_paused" },
    });
  });

  it("serves published reports without a cache window so unpublish is immediate", async () => {
    const database = {
      prepare: (query: string) => {
        const statement = {
          bind: () => statement,
          first: async <T>() =>
            query.includes("FROM public_reports")
              ? ({
                  id: "public-1",
                  scan_id: "scan-1",
                  artifact_key: "public/scan-1/report.json",
                  status: "published",
                  author_confirmed_at: "2026-07-16T00:00:00.000Z",
                } as T)
              : null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    };
    const body = JSON.stringify({
      schemaVersion: "grimodex-scan/public-report/1",
    });
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/public-reports/public-1"),
      env({
        DB: database,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => ({
            body: new Response(body).body,
            size: body.length,
            httpMetadata: { contentType: "application/json" },
          }),
          head: async () => null,
          delete: async () => undefined,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
