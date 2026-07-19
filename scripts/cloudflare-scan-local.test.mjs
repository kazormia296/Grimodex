/* global Response */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";

import {
  createScanLocalPlan,
  parseScanLocalArgs,
  runLocalQuickScanSmoke,
  startLocalServices,
  validateLocalScanReport,
  waitForEndpoint,
} from "./cloudflare-scan-local.mjs";

const scanId = "12345678-1234-4123-8123-123456789abc";
const scanToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const minimalScanBundle = JSON.parse(
  await readFile(
    new URL(
      "../packages/scan-contract/test/fixtures/minimal-ja.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("Cloudflare Scan local runner", () => {
  it("builds, migrates, and starts an account-free local stack", () => {
    const plan = createScanLocalPlan();

    assert.deepEqual(
      {
        persistDirectory: plan.persistDirectory,
        editorOrigin: plan.editorOrigin,
        webOrigin: plan.webOrigin,
        workerOrigin: plan.workerOrigin,
      },
      {
        persistDirectory: ".wrangler/scan-local",
        editorOrigin: "http://localhost:1430",
        webOrigin: "http://127.0.0.1:4173",
        workerOrigin: "http://127.0.0.1:8787",
      },
    );
    assert.deepEqual(plan.setup, [
      {
        command: "pnpm",
        args: ["build:scan"],
        env: {
          VITE_SCAN_API_BASE_URL: "http://127.0.0.1:8787",
          VITE_SCAN_TURNSTILE_REQUIRED: "false",
          VITE_EDITOR_BASE_URL: "http://localhost:1430/editor",
        },
      },
      {
        command: "pnpm",
        args: [
          "exec",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--config",
          "apps/scan-web/wrangler.jsonc",
          "--env-file",
          "apps/scan-web/local-only.env",
          "--persist-to",
          ".wrangler/scan-local",
        ],
        env: {
          CI: "true",
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        },
      },
    ]);
    assert.deepEqual(plan.services, [
      {
        name: "worker",
        command: "pnpm",
        args: [
          "exec",
          "wrangler",
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          "8787",
          "--config",
          "apps/scan-web/wrangler.jsonc",
          "--env-file",
          "apps/scan-web/local-only.env",
          "--persist-to",
          ".wrangler/scan-local",
          "--show-interactive-dev-session=false",
        ],
        env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" },
      },
      {
        name: "web",
        command: "pnpm",
        args: [
          "--dir",
          "apps/scan-web",
          "exec",
          "vite",
          "preview",
          "--host",
          "127.0.0.1",
          "--port",
          "4173",
          "--strictPort",
        ],
      },
    ]);
  });

  it("keeps the default Wrangler config local, active, and credential-free", async () => {
    const config = parse(
      await readFile(
        new URL("../apps/scan-web/wrangler.jsonc", import.meta.url),
        "utf8",
      ),
    );

    assert.equal(config.vars.SCAN_ENVIRONMENT, "development");
    assert.equal(config.vars.SCAN_ACCEPTING_NEW_JOBS, "true");
    assert.equal(config.vars.SCAN_WORKERS_AI_ENABLED, "false");
    assert.equal(config.vars.SCAN_FRONTIER_ENABLED, "false");
    assert.equal(config.vars.SCAN_EDITOR_AI_ENABLED, "false");
    assert.equal(
      config.vars.ALLOWED_ORIGINS,
      "http://127.0.0.1:4173,http://localhost:1430",
    );
    assert.equal(config.d1_databases[0].preview_database_id, "scan-local");
    assert.equal("ai" in config, false);
    assert.equal(config.d1_databases[0].remote, undefined);
    assert.equal(config.r2_buckets[0].remote, undefined);
    const controlledEnvironment = await readFile(
      new URL("../apps/scan-web/local-only.env", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(controlledEnvironment, /^\s*[^#\s][^=]*=/mu);
  });

  it("accepts only the documented local flags", () => {
    assert.deepEqual(parseScanLocalArgs([]), { help: false, smoke: false });
    assert.deepEqual(parseScanLocalArgs(["--smoke"]), {
      help: false,
      smoke: true,
    });
    assert.deepEqual(parseScanLocalArgs(["--help"]), {
      help: true,
      smoke: false,
    });
    assert.throws(() => parseScanLocalArgs(["staging"]), /unknown argument/);
  });

  it("exercises a complete deterministic Quick Scan and cleans it up", async () => {
    const requests = [];
    const sleeps = [];
    let statusReads = 0;
    const fetchImpl = async (url, init = {}) => {
      const requestUrl = new URL(url);
      const method = init.method ?? "GET";
      requests.push({ method, pathname: requestUrl.pathname, init });
      if (requestUrl.origin === "http://127.0.0.1:4173") {
        return new Response(
          '<!doctype html><title>Grimodex Scan</title><div id="root"></div>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (requestUrl.pathname === "/api/v1/health") {
        return Response.json(
          {
            ok: true,
            service: "grimodex-scan",
            acceptingNewJobs: true,
          },
          {
            headers: {
              "access-control-allow-origin": "http://127.0.0.1:4173",
            },
          },
        );
      }
      if (requestUrl.pathname === "/api/v1/ai-disclosures/scan") {
        return Response.json({
          route: "scan",
          consentId: "consent_local_scan_smoke_1234567890",
        });
      }
      if (
        requestUrl.pathname === "/api/v1/upload-intents" &&
        method === "POST"
      ) {
        return Response.json(
          {
            uploadId: "upload-1",
            uploadUrl: "http://127.0.0.1:8787/api/v1/uploads/upload-1",
            uploadToken: "upload-token",
            expiresAt: "2026-07-19T00:00:00.000Z",
          },
          { status: 201 },
        );
      }
      if (
        requestUrl.pathname === "/api/v1/uploads/upload-1" &&
        method === "PUT"
      ) {
        return Response.json({ uploadId: "upload-1", status: "uploaded" });
      }
      if (
        requestUrl.pathname === "/api/v1/uploads/upload-1/complete" &&
        method === "POST"
      ) {
        return Response.json({ uploadId: "upload-1", status: "uploaded" });
      }
      if (requestUrl.pathname === "/api/v1/scans" && method === "POST") {
        return Response.json(
          { scanId, scanToken, mode: "quick", status: "queued" },
          { status: 202 },
        );
      }
      if (
        requestUrl.pathname === `/api/v1/scans/${scanId}` &&
        method === "GET"
      ) {
        statusReads += 1;
        return Response.json({
          scanId,
          mode: "quick",
          status: statusReads === 1 ? "extracting" : "completed",
          updatedAt: "2026-07-19T00:00:00.000Z",
        });
      }
      if (requestUrl.pathname === `/api/v1/scans/${scanId}/report`) {
        return Response.json(minimalScanBundle);
      }
      if (
        requestUrl.pathname === `/api/v1/scans/${scanId}/editor-tokens` &&
        method === "POST"
      ) {
        return Response.json(
          {
            token: "editor-token",
            expiresAt: "2026-07-19T01:00:00.000Z",
          },
          { status: 201 },
        );
      }
      if (requestUrl.pathname === "/api/v1/editor-seeds") {
        return Response.json(
          {
            schemaVersion: "grimodex/editor-handoff/1",
            seed: {
              schemaVersion: "grimodex-scan/editor-seed/1",
              bundle: minimalScanBundle,
              source: {
                schemaVersion: "grimodex-scan/source-document/1",
                title: minimalScanBundle.source.title,
                language: minimalScanBundle.source.language,
                fingerprint: minimalScanBundle.source.fingerprint,
                sections: minimalScanBundle.sections.map((section) => ({
                  id: section.id,
                  ordinal: section.ordinal,
                  title: section.title,
                  paragraphIds: section.paragraphIds,
                })),
                paragraphs: [
                  {
                    id: "paragraph:0:0:1111111111111111111111111111111111111111111111111111111111111111",
                    sectionId:
                      "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    ordinal: 0,
                    text: "葵は灯台の窓を開けた。",
                  },
                  {
                    id: "paragraph:0:1:2222222222222222222222222222222222222222222222222222222222222222",
                    sectionId:
                      "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    ordinal: 1,
                    text: "白灯台には古い手紙が残っていた。",
                  },
                ],
              },
            },
            hostedAiSession: {
              scanId,
              token: "a".repeat(64),
              expiresAt: "2026-07-20T00:00:00.000Z",
            },
          },
          {
            headers: {
              "access-control-allow-origin": "http://localhost:1430",
            },
          },
        );
      }
      if (
        requestUrl.pathname === `/api/v1/scans/${scanId}` &&
        method === "DELETE"
      ) {
        return Response.json({ scanId, status: "deleted" });
      }
      return new Response("not found", { status: 404 });
    };

    await assert.doesNotReject(async () => {
      const result = await runLocalQuickScanSmoke({
        fetchImpl,
        scanId,
        scanToken,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      });
      assert.deepEqual(result, {
        editorHandoff: "validated",
        entityCount: 2,
        eventCount: 1,
        findingCount: 1,
        scanId,
        status: "completed",
      });
    });
    assert.deepEqual(
      requests.map(({ method, pathname }) => `${method} ${pathname}`),
      [
        "GET /api/v1/health",
        "GET /",
        "GET /api/v1/ai-disclosures/scan",
        "POST /api/v1/upload-intents",
        "PUT /api/v1/uploads/upload-1",
        "POST /api/v1/uploads/upload-1/complete",
        "POST /api/v1/scans",
        `GET /api/v1/scans/${scanId}`,
        `GET /api/v1/scans/${scanId}`,
        `GET /api/v1/scans/${scanId}/report`,
        `POST /api/v1/scans/${scanId}/editor-tokens`,
        "GET /api/v1/editor-seeds",
        `DELETE /api/v1/scans/${scanId}`,
      ],
    );
    const uploadIntentRequest = requests.find(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/api/v1/upload-intents",
    );
    assert.equal(
      uploadIntentRequest.init.headers["x-ai-consent-id"],
      "consent_local_scan_smoke_1234567890",
    );
    assert.deepEqual(sleeps, [12_000, 250]);
  });

  it("rejects a local Worker that is still paused", async () => {
    const fetchImpl = async (url) => {
      if (new URL(url).pathname === "/api/v1/health") {
        return Response.json({
          ok: true,
          service: "grimodex-scan",
          acceptingNewJobs: false,
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    await assert.rejects(
      runLocalQuickScanSmoke({ fetchImpl, scanId, scanToken }),
      /accepting Quick Scan jobs/,
    );
  });

  it("validates the complete ScanBundle contract and deterministic evidence", async () => {
    await assert.doesNotReject(validateLocalScanReport(minimalScanBundle));
    await assert.rejects(
      validateLocalScanReport({
        schemaVersion: "grimodex-scan/1",
        findings: [],
      }),
      /public contract/,
    );
  });

  it("bounds an unresponsive local request", async () => {
    await assert.rejects(
      Promise.race([
        runLocalQuickScanSmoke({
          fetchImpl: async () => new Promise(() => undefined),
          requestTimeoutMs: 5,
          scanId,
          scanToken,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("runner did not bound its request")),
            50,
          ),
        ),
      ]),
      /local Worker health timed out/,
    );
  });

  it("bounds a response whose body never finishes", async () => {
    await assert.rejects(
      Promise.race([
        runLocalQuickScanSmoke({
          fetchImpl: async () => ({
            headers: new Headers({
              "access-control-allow-origin": "http://127.0.0.1:4173",
            }),
            status: 200,
            text: async () => new Promise(() => undefined),
          }),
          requestTimeoutMs: 5,
          scanId,
          scanToken,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("response body was not bounded")),
            50,
          ),
        ),
      ]),
      /local Worker health timed out/,
    );
  });

  it("cancels an in-flight smoke request when shutdown begins", async () => {
    const controller = new AbortController();
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    const smoke = runLocalQuickScanSmoke({
      fetchImpl: async (_url, { signal }) => {
        markFetchStarted();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      requestTimeoutMs: 45_000,
      scanId,
      scanToken,
      signal: controller.signal,
    });

    await fetchStarted;
    controller.abort(new Error("smoke interrupted"));

    await assert.rejects(
      Promise.race([
        smoke,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("smoke did not cancel promptly")),
            50,
          ),
        ),
      ]),
      /smoke interrupted/,
    );
  });

  it("cancels startup probes without waiting for the readiness deadline", async () => {
    const controller = new AbortController();
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    const probe = waitForEndpoint(
      "http://127.0.0.1:8787/health",
      "local Worker",
      {
        fetchImpl: async (_url, { signal }) => {
          markFetchStarted();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        signal: controller.signal,
        timeoutMs: 45_000,
      },
    );

    await fetchStarted;
    controller.abort(new Error("startup cancelled"));

    await assert.rejects(
      Promise.race([
        probe,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("startup probe did not cancel promptly")),
            50,
          ),
        ),
      ]),
      /startup cancelled/,
    );
  });

  it("force-kills a detached service group after its wrapper exits", async () => {
    const child = new EventEmitter();
    Object.assign(child, {
      exitCode: 0,
      kill: () => undefined,
      pid: 43210,
      signalCode: null,
    });
    let groupAlive = true;
    const deliveredSignals = [];
    const stack = startLocalServices(
      [
        {
          name: "worker",
          command: "fake-worker",
          args: [],
        },
      ],
      {
        forceShutdownMs: 0,
        gracefulShutdownMs: 0,
        killProcess: (pid, signal) => {
          if (signal === 0) {
            if (groupAlive) return;
            const error = new Error("process group not found");
            error.code = "ESRCH";
            throw error;
          }
          deliveredSignals.push([pid, signal]);
          if (signal === "SIGKILL") groupAlive = false;
        },
        platform: "linux",
        spawnImpl: () => child,
      },
    );

    await stack.stop();

    assert.deepEqual(deliveredSignals, [
      [-43210, "SIGTERM"],
      [-43210, "SIGKILL"],
    ]);
  });

  it("uses the Windows command shell and terminates the full child tree", async () => {
    const child = new EventEmitter();
    Object.assign(child, {
      exitCode: null,
      kill: () => undefined,
      pid: 54321,
      signalCode: null,
    });
    let spawned;
    let taskkill;
    const stack = startLocalServices(
      [
        {
          name: "worker",
          command: "pnpm",
          args: ["exec", "wrangler", "dev"],
        },
      ],
      {
        environment: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        },
        forceShutdownMs: 0,
        gracefulShutdownMs: 0,
        platform: "win32",
        spawnImpl: (command, args, options) => {
          spawned = { args, command, options };
          return child;
        },
        spawnSyncImpl: (command, args, options) => {
          taskkill = { args, command, options };
          child.exitCode = 0;
          return { status: 0 };
        },
      },
    );

    await stack.stop();

    assert.deepEqual(
      {
        args: spawned.args,
        command: spawned.command,
        detached: spawned.options.detached,
        shell: spawned.options.shell,
      },
      {
        args: ["/d", "/s", "/c", "pnpm", "exec", "wrangler", "dev"],
        command: "C:\\Windows\\System32\\cmd.exe",
        detached: false,
        shell: false,
      },
    );
    assert.deepEqual(taskkill, {
      args: ["/PID", "54321", "/T", "/F"],
      command: "taskkill.exe",
      options: {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    });
  });
});
