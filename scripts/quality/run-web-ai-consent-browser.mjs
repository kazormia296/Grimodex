#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Gate B2 browser server did not expose an address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(true)));
  });
}

async function startProviderServer() {
  const accessLog = [];
  const server = createServer(async (request, response) => {
    Object.entries(corsHeaders()).forEach(([key, value]) =>
      response.setHeader(key, value),
    );
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    if (method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "GET" && url === "/__gate_b2_stats") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          chatRequestCount: accessLog.length,
          accessLog,
        }),
      );
      return;
    }
    if (method === "POST" && /\/chat\/completions$/u.test(url)) {
      await readRequestBody(request);
      accessLog.push({ method, url, at: new Date().toISOString() });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-gate-b2-browser",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "loopback-ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    statsUrl: `${baseUrl}/__gate_b2_stats`,
    accessLog,
    close: () => closeServer(server),
  };
}

async function startEvidenceServer() {
  let resolveEvidence;
  let rejectEvidence;
  const evidencePromise = new Promise((resolve, reject) => {
    resolveEvidence = resolve;
    rejectEvidence = reject;
  });
  const server = createServer(async (request, response) => {
    Object.entries(corsHeaders()).forEach(([key, value]) =>
      response.setHeader(key, value),
    );
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    if (method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "POST" && url === "/__gate_b2_evidence") {
      try {
        const body = JSON.parse(await readRequestBody(request));
        resolveEvidence(body);
        response.writeHead(204);
        response.end();
      } catch (error) {
        rejectEvidence(error);
        response.writeHead(400);
        response.end("invalid evidence");
      }
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  const baseUrl = await listen(server);
  return {
    evidenceUrl: `${baseUrl}/__gate_b2_evidence`,
    evidencePromise,
    close: () => closeServer(server),
  };
}

function runVitest(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "--config",
        "vitest.gate-b2-web-ai-consent.config.ts",
        "--run",
      ],
      { cwd: repoRoot, env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code: code ?? 1, signal }),
    );
  });
}

function sha256Json(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function isValidEvidence(evidence, providerRequestCount) {
  if (!evidence || evidence.result !== "passed") return false;
  const beforeConsent = integer(evidence.requestCountBeforeConsent);
  const afterRefuse = integer(evidence.requestCountAfterRefuse);
  const afterApprove = integer(evidence.requestCountAfterApprove);
  const afterDestinationRefuse = integer(
    evidence.requestCountAfterDestinationChangeRefuse,
  );
  return (
    beforeConsent === 0 &&
    afterRefuse === 0 &&
    afterApprove !== null &&
    afterApprove > 0 &&
    afterDestinationRefuse === afterApprove &&
    afterDestinationRefuse === providerRequestCount &&
    evidence.localStorageCleared === true &&
    evidence.indexedDbCleared === true &&
    evidence.consentBrokerDeclined === true &&
    evidence.browserMockClosed === true
  );
}

async function writeReport({
  provider,
  evidence,
  providerServerClosed,
  evidenceServerClosed,
  childResult,
  startedAt,
}) {
  const completedAt = new Date().toISOString();
  const providerRequestCount = provider.accessLog.length;
  const certificationEligible =
    childResult.code === 0 &&
    providerServerClosed === true &&
    evidenceServerClosed === true &&
    isValidEvidence(evidence, providerRequestCount);
  const binding = {
    ...(process.env.GATE_B2_CANDIDATE_COMMIT_SHA
      ? { candidateCommitSha: process.env.GATE_B2_CANDIDATE_COMMIT_SHA }
      : {}),
    ...(process.env.GATE_B2_CANDIDATE_TREE_SHA
      ? { candidateTreeSha: process.env.GATE_B2_CANDIDATE_TREE_SHA }
      : {}),
    ...(process.env.GATE_B2_SUITE_ID
      ? { suiteId: process.env.GATE_B2_SUITE_ID }
      : {}),
    ...(process.env.GATE_B2_RUN_ID ? { runId: process.env.GATE_B2_RUN_ID } : {}),
    ...(process.env.GATE_B2_COMMAND_DIGEST
      ? { commandDigest: process.env.GATE_B2_COMMAND_DIGEST }
      : {}),
    ...(process.env.GATE_B2_FREEZE_ID
      ? { freezeId: process.env.GATE_B2_FREEZE_ID }
      : {}),
    ...(process.env.GATE_B2_CERTIFICATION_RUN_ID
      ? { certificationRunId: process.env.GATE_B2_CERTIFICATION_RUN_ID }
      : {}),
    ...(process.env.GATE_B2_ATTEMPT
      ? { attempt: Number(process.env.GATE_B2_ATTEMPT) }
      : {}),
  };
  const report = {
    schemaVersion: 1,
    mode: "web-ai-consent-browser-live",
    runId:
      process.env.GATE_B2_RUN_ID ??
      `web-ai-consent-browser-${startedAt.replace(/[:.]/gu, "-")}`,
    startedAt,
    completedAt,
    finishedAt: completedAt,
    ...binding,
    certificationEligible,
    browser: {
      realBrowser: true,
      provider: "@vitest/browser-playwright",
      engine: "chromium",
      headless: true,
    },
    requestCountBeforeConsent: integer(evidence?.requestCountBeforeConsent),
    requestCountAfterRefuse: integer(evidence?.requestCountAfterRefuse),
    requestCountAfterApprove: integer(evidence?.requestCountAfterApprove),
    requestCountAfterDestinationChangeRefuse: integer(
      evidence?.requestCountAfterDestinationChangeRefuse,
    ),
    providerRequestCount,
    accessLogDigest: sha256Json(provider.accessLog),
    endpoints: {
      a: `${provider.baseUrl}/consent-a/v1`,
      b: `${provider.baseUrl}/consent-b/v1`,
    },
    assertions: Array.isArray(evidence?.assertions) ? evidence.assertions : [],
    teardown: {
      serverClosed: providerServerClosed === true,
      evidenceServerClosed: evidenceServerClosed === true,
      localStorageCleared: evidence?.localStorageCleared === true,
      indexedDbCleared: evidence?.indexedDbCleared === true,
      consentBrokerDeclined: evidence?.consentBrokerDeclined === true,
      browserMockClosed: evidence?.browserMockClosed === true,
    },
  };
  const outputPath =
    process.env.GATE_B2_OUTPUT_PATH ??
    path.join(repoRoot, ".artifacts", "web-ai-consent-browser", "report.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, outputPath };
}

async function main() {
  const startedAt = new Date().toISOString();
  const provider = await startProviderServer();
  const evidenceServer = await startEvidenceServer();
  let providerServerClosed = false;
  let evidenceServerClosed = false;
  let childResult = { code: 1, signal: null };
  let evidence = null;
  try {
    childResult = await runVitest({
      ...process.env,
      GATE_B2_PROVIDER_BASE_URL: provider.baseUrl,
      GATE_B2_PROVIDER_STATS_URL: provider.statsUrl,
      GATE_B2_EVIDENCE_URL: evidenceServer.evidenceUrl,
    });
    evidence = await Promise.race([
      evidenceServer.evidencePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    providerServerClosed = await provider.close();
    evidenceServerClosed = await evidenceServer.close();
    const { report, outputPath } = await writeReport({
      provider,
      evidence,
      providerServerClosed,
      evidenceServerClosed,
      childResult,
      startedAt,
    });
    const summary = JSON.stringify({
      outputPath,
      certificationEligible: report.certificationEligible,
      providerRequestCount: report.providerRequestCount,
      serverClosed: report.teardown.serverClosed,
      indexedDbCleared: report.teardown.indexedDbCleared,
      localStorageCleared: report.teardown.localStorageCleared,
    });
    process.stdout.write(`[gate-b2-web-ai-consent-browser] ${summary}\n`);
    if (!report.certificationEligible) process.exitCode = 1;
  } finally {
    if (!providerServerClosed) {
      try {
        await provider.close();
      } catch {
        // Preserve the test failure.
      }
    }
    if (!evidenceServerClosed) {
      try {
        await evidenceServer.close();
      } catch {
        // Preserve the test failure.
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
