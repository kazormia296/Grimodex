/* global Response */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  createScanDeployPlan,
  runScanSmokeChecks,
  validateScanDeployConfig,
  validateRemoteD1Info,
  validateRemoteR2Info,
} from "./cloudflare-scan-deploy.mjs";

const stagingConfig = `{
  "name": "grimodex-scan-staging",
  "vars": {
    "SCAN_ACCEPTING_NEW_JOBS": "false",
    "SCAN_TURNSTILE_REQUIRED": "false",
    "SCAN_ENVIRONMENT": "staging",
    "ALLOWED_ORIGIN": "https://grimodex-try-staging.pages.dev"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "grimodex-scan-staging",
    "database_id": "12345678-1234-1234-1234-123456789abc"
  }],
  "r2_buckets": [{
    "binding": "SCAN_BUCKET",
    "bucket_name": "grimodex-scan-staging"
  }],
  "workflows": [{
    "name": "grimodex-scan-staging-workflow",
    "binding": "SCAN_WORKFLOW"
  }]
}`;

const productionAcceptingConfig = stagingConfig
  .replaceAll("grimodex-scan-staging", "grimodex-scan-production")
  .replace('"SCAN_ENVIRONMENT": "staging"', '"SCAN_ENVIRONMENT": "production"')
  .replace("https://grimodex-try-staging.pages.dev", "https://try.grimodex.app")
  .replace(
    '"SCAN_ACCEPTING_NEW_JOBS": "false"',
    '"SCAN_ACCEPTING_NEW_JOBS": "true"',
  );

const stagingAcceptingConfig = stagingConfig.replace(
  '"SCAN_ACCEPTING_NEW_JOBS": "false"',
  '"SCAN_ACCEPTING_NEW_JOBS": "true"',
);

const migrationsDir = fileURLToPath(
  new URL("../apps/scan-web/migrations/", import.meta.url),
);

function createSmokeFetch({ fallbackAssets = false } = {}) {
  const requests = [];
  const indexHtml =
    '<!doctype html><title>Grimodex Scan</title><div id="root"></div>';
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/api/v1/health")) {
      return Response.json(
        {
          ok: true,
          service: "grimodex-scan",
          acceptingNewJobs: false,
        },
        {
          headers: {
            "access-control-allow-origin":
              "https://grimodex-try-staging.pages.dev",
          },
        },
      );
    }
    if (init.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers:
          init.headers.origin === "https://hostile.invalid"
            ? {}
            : {
                "access-control-allow-origin":
                  "https://grimodex-try-staging.pages.dev",
              },
      });
    }
    if (url.endsWith("/api/v1/upload-intents")) {
      return Response.json(
        { error: { code: "scan_paused" } },
        {
          status: 503,
          headers: {
            "access-control-allow-origin":
              "https://grimodex-try-staging.pages.dev",
          },
        },
      );
    }
    if (fallbackAssets) {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.endsWith("/manifest.webmanifest")) {
      return new Response(
        JSON.stringify({
          name: "Grimodex Scan",
          short_name: "Grimodex",
          start_url: ".",
          display: "standalone",
        }),
        { headers: { "content-type": "application/manifest+json" } },
      );
    }
    if (url.endsWith("/sw.js")) {
      return new Response(
        'const CACHE_PREFIX = "grimodex-scan-shell-"; self.addEventListener("fetch", () => {});',
        { headers: { "content-type": "application/javascript" } },
      );
    }
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  return { fetchImpl, requests };
}

describe("Cloudflare Scan deploy CLI", () => {
  it("accepts a paused staging config with concrete bindings", () => {
    assert.deepEqual(
      validateScanDeployConfig({
        environment: "staging",
        configText: stagingConfig,
      }),
      {
        acceptingNewJobs: false,
        allowedOrigin: "https://grimodex-try-staging.pages.dev",
        bucketName: "grimodex-scan-staging",
        databaseId: "12345678-1234-1234-1234-123456789abc",
        databaseName: "grimodex-scan-staging",
        scanEnvironment: "staging",
        workerName: "grimodex-scan-staging",
        workflowName: "grimodex-scan-staging-workflow",
      },
    );
  });

  it("rejects placeholders, origin drift, and active staging traffic", () => {
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            "12345678-1234-1234-1234-123456789abc",
            "replace-with-staging-d1-id",
          ),
        }),
      /placeholder/,
    );
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            "https://grimodex-try-staging.pages.dev",
            "https://unexpected.example",
          ),
        }),
      /ALLOWED_ORIGIN/,
    );
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingAcceptingConfig,
        }),
      /staging traffic activation is not supported/,
    );
  });

  it("rejects duplicate keys before reading deployment guard values", () => {
    for (const configText of [
      stagingConfig.replace(
        '"name": "grimodex-scan-staging"',
        '"name": "grimodex-scan-production",\n  "name": "grimodex-scan-staging"',
      ),
      stagingConfig.replace(
        '"SCAN_ENVIRONMENT": "staging"',
        '"SCAN_ENVIRONMENT": "production",\n    "SCAN_ENVIRONMENT": "staging"',
      ),
      stagingConfig.replace(
        '"database_id": "12345678-1234-1234-1234-123456789abc"',
        '"database_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",\n    "database_id": "12345678-1234-1234-1234-123456789abc"',
      ),
    ]) {
      assert.throws(
        () =>
          validateScanDeployConfig({
            environment: "staging",
            configText,
          }),
        /duplicate key/,
      );
    }
  });

  it("rejects cross-environment bindings and unresolved placeholders", () => {
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            '"bucket_name": "grimodex-scan-staging"',
            '"bucket_name": "grimodex-scan-production"',
          ),
        }),
      /bucket_name/,
    );
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            "grimodex-scan-staging-workflow",
            "grimodex-scan-production-workflow",
          ),
        }),
      /workflow name/,
    );
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            '"SCAN_ENVIRONMENT": "staging"',
            '"SCAN_ENVIRONMENT": "production"',
          ),
        }),
      /SCAN_ENVIRONMENT/,
    );
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            '"SCAN_ENVIRONMENT": "staging"',
            '"SCAN_ENVIRONMENT": "staging", "EXTRA": "replace-with-value"',
          ),
        }),
      /placeholder/,
    );
  });

  it("builds deterministic worker and Pages command plans", () => {
    assert.deepEqual(
      createScanDeployPlan({
        action: "worker-dry-run",
        environment: "staging",
      }),
      [
        {
          command: "pnpm",
          args: ["build:scan:dependencies"],
        },
        {
          command: "pnpm",
          args: [
            "exec",
            "wrangler",
            "deploy",
            "--dry-run",
            "--config",
            "apps/scan-web/wrangler.staging.jsonc",
          ],
        },
      ],
    );

    assert.deepEqual(
      createScanDeployPlan({
        action: "web-deploy",
        environment: "staging",
        apiBaseUrl: "https://grimodex-scan-staging.kazormia296.workers.dev",
      }),
      [
        {
          command: "pnpm",
          args: ["build:scan"],
          env: {
            VITE_SCAN_API_BASE_URL:
              "https://grimodex-scan-staging.kazormia296.workers.dev",
            VITE_SCAN_TURNSTILE_REQUIRED: "false",
          },
        },
        {
          command: "pnpm",
          args: [
            "exec",
            "wrangler",
            "pages",
            "deploy",
            "apps/scan-web/dist",
            "--project-name",
            "grimodex-scan-staging",
            "--branch",
            "master",
          ],
        },
      ],
    );
  });

  it("requires explicit production mutation and blocks HTTP deploy without a route", () => {
    assert.throws(
      () =>
        createScanDeployPlan({
          action: "worker-deploy",
          environment: "production",
        }),
      /--allow-production/,
    );
    assert.throws(
      () =>
        createScanDeployPlan({
          action: "web-deploy",
          environment: "production",
          apiBaseUrl: "https://api.example.com",
          allowProduction: true,
        }),
      /custom Worker route/,
    );
    assert.throws(
      () =>
        createScanDeployPlan({
          action: "worker-deploy",
          environment: "production",
          allowProduction: true,
        }),
      /custom Worker route/,
    );
    assert.throws(
      () =>
        createScanDeployPlan({
          action: "web-build",
          environment: "production",
          apiBaseUrl: "https://api.example.com",
        }),
      /custom Worker route/,
    );
    assert.throws(
      () =>
        createScanDeployPlan({
          action: "web-build",
          environment: "staging",
          apiBaseUrl: "https://api.example.com/unexpected-path",
        }),
      /HTTPS origin/,
    );

    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "production",
          configText: productionAcceptingConfig,
          allowProductionTraffic: false,
        }),
      /production traffic/,
    );
    assert.equal(
      validateScanDeployConfig({
        environment: "production",
        configText: productionAcceptingConfig,
        allowProductionTraffic: true,
      }).acceptingNewJobs,
      true,
    );
  });

  it("matches configured bindings to remote D1 and R2 resources", () => {
    assert.deepEqual(
      validateRemoteD1Info({
        environment: "staging",
        databaseId: "12345678-1234-1234-1234-123456789abc",
        infoText: JSON.stringify({
          name: "grimodex-scan-staging",
          uuid: "12345678-1234-1234-1234-123456789abc",
        }),
      }),
      {
        name: "grimodex-scan-staging",
        uuid: "12345678-1234-1234-1234-123456789abc",
      },
    );
    assert.throws(
      () =>
        validateRemoteD1Info({
          environment: "staging",
          databaseId: "12345678-1234-1234-1234-123456789abc",
          infoText: JSON.stringify({
            name: "grimodex-scan-staging",
            uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          }),
        }),
      /does not match/,
    );
    assert.deepEqual(
      validateRemoteR2Info({
        environment: "staging",
        infoText: JSON.stringify({ name: "grimodex-scan-staging" }),
      }),
      { name: "grimodex-scan-staging" },
    );
  });

  it("smoke-checks paused Worker, CORS, and canonical Pages assets", async () => {
    const { fetchImpl, requests } = createSmokeFetch();

    assert.deepEqual(
      await runScanSmokeChecks({
        environment: "staging",
        apiBaseUrl: "https://grimodex-scan-staging.kazormia296.workers.dev/",
        fetchImpl,
      }),
      {
        acceptingNewJobs: false,
        apiBaseUrl: "https://grimodex-scan-staging.kazormia296.workers.dev",
        pagesOrigin: "https://grimodex-try-staging.pages.dev",
      },
    );
    assert.equal(requests.length, 7);
  });

  it("rejects arbitrary staging API origins and Pages SPA fallbacks", async () => {
    assert.throws(
      () =>
        createScanDeployPlan({
          action: "web-build",
          environment: "staging",
          apiBaseUrl: "https://api.example.com",
        }),
      /staging Worker URL/,
    );

    const { fetchImpl } = createSmokeFetch({ fallbackAssets: true });
    await assert.rejects(
      runScanSmokeChecks({
        environment: "staging",
        apiBaseUrl: "https://grimodex-scan-staging.kazormia296.workers.dev",
        fetchImpl,
      }),
      /manifest.*content type/i,
    );
  });

  it("never disables D1 foreign-key enforcement in migrations", async () => {
    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    const violations = [];

    for (const file of files) {
      const sql = await readFile(`${migrationsDir}/${file}`, "utf8");
      for (const [index, line] of sql.split(/\r?\n/).entries()) {
        if (/\bPRAGMA\s+foreign_keys\s*=\s*(?:OFF|0)\b/i.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });
});
