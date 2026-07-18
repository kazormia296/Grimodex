import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createScanDeployPlan,
  validateScanDeployConfig,
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
    "database_id": "12345678-1234-1234-1234-123456789abc"
  }]
}`;

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
        databaseId: "12345678-1234-1234-1234-123456789abc",
        workerName: "grimodex-scan-staging",
      },
    );
  });

  it("rejects placeholders, origin drift, and unsafe production traffic", () => {
    assert.throws(
      () =>
        validateScanDeployConfig({
          environment: "staging",
          configText: stagingConfig.replace(
            "12345678-1234-1234-1234-123456789abc",
            "replace-with-staging-d1-id",
          ),
        }),
      /database_id/,
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
          environment: "production",
          configText: stagingConfig
            .replaceAll("staging", "production")
            .replace("grimodex-try-production.pages.dev", "try.grimodex.app")
            .replace(
              '"SCAN_ACCEPTING_NEW_JOBS": "false"',
              '"SCAN_ACCEPTING_NEW_JOBS": "true"',
            ),
        }),
      /production traffic/,
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
        apiBaseUrl: "https://api-staging.example.workers.dev",
      }),
      [
        {
          command: "pnpm",
          args: ["build:scan"],
          env: {
            VITE_SCAN_API_BASE_URL:
              "https://api-staging.example.workers.dev",
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
            "grimodex-try-staging",
          ],
        },
      ],
    );
  });

  it("requires explicit production mutation and Turnstile inputs", () => {
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
      /Turnstile site key/,
    );
  });
});
