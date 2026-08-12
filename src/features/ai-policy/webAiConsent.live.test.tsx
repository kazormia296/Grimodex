// @vitest-environment jsdom
/**
 * Gate B2 Heavy: web AI consent against a real loopback OpenAI-compatible LLM.
 *
 * Proves consent dialog → refuse (0 HTTP) → approve (>0 HTTP) → destination
 * change re-consent → refuse again (no new HTTP). Model quality is out of scope.
 *
 *   pnpm eval:web-ai-consent:live
 */
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserMock } from "@/lib/browser-mock";
import { AiDataConsentGate } from "./AiDataConsentGate";
import { declineActiveAiDataConsent } from "./aiDataConsentBroker";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface LoopbackServer {
  readonly baseUrlA: string;
  readonly baseUrlB: string;
  readonly accessLog: Array<{ method: string; url: string; at: string }>;
  requestCount(): number;
  close(): Promise<void>;
}

function browserAuditContext(executionId: string) {
  return {
    expectedWorkspacePath: "/dev/workspace",
    projectId: "default-project",
    operationId: `operation-${executionId}`,
    executionId,
    parentExecutionId: null,
    pathId: "browser_byok_web",
  } as const;
}

async function prepareAuditedDispatch(
  mock: Awaited<ReturnType<typeof createBrowserMock>>,
  executionId: string,
) {
  const context = browserAuditContext(executionId);
  const event = (eventType: string, sequence: number) => ({
    eventId: `${executionId}-${sequence}`,
    executionId,
    operationId: context.operationId,
    parentExecutionId: context.parentExecutionId,
    pathId: context.pathId,
    eventType,
    timestamp: sequence,
    payload: {
      captureState: "complete",
      credentialsExcluded: true,
      request: { messages: [{ role: "user", content: executionId }] },
    },
  });
  await mock.invoke("ai_audit_append_batch", {
    expectedWorkspacePath: context.expectedWorkspacePath,
    projectId: context.projectId,
    events: [
      event("execution.started", 1),
      event("request.prepared", 2),
      event("request.dispatched", 3),
    ],
  });
  return context;
}

async function startLoopbackLlm(): Promise<LoopbackServer> {
  const accessLog: Array<{ method: string; url: string; at: string }> = [];
  const server: Server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,authorization",
      });
      res.end();
      return;
    }
    if (method === "POST" && url.includes("/chat/completions")) {
      accessLog.push({
        method,
        url,
        at: new Date().toISOString(),
      });
      const body = JSON.stringify({
        id: "chatcmpl-loopback",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "loopback-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind loopback LLM");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrlA: `${origin}/consent-a/v1`,
    baseUrlB: `${origin}/consent-b/v1`,
    accessLog,
    requestCount: () => accessLog.length,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function configureCompatibleEndpoint(
  mock: Awaited<ReturnType<typeof createBrowserMock>>,
  endpoint: { id: string; label: string; baseUrl: string },
) {
  await mock.invoke("save_ai_settings", {
    settings: {
      provider: "openai-compatible",
      model: "loopback-model",
      openaiCompatible: { baseUrl: endpoint.baseUrl },
      openaiCompatibleEndpoints: [
        {
          id: endpoint.id,
          label: endpoint.label,
          baseUrl: endpoint.baseUrl.endsWith("/")
            ? endpoint.baseUrl
            : `${endpoint.baseUrl}/`,
          apiVariant: null,
        },
      ],
      activeOpenaiCompatibleEndpointId: endpoint.id,
    },
  });
}

async function acceptVisibleConsent(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", {
    name: "AIで処理する前に確認",
  });
  expect(dialog).toBeTruthy();
  const checkbox = screen.getByRole("checkbox");
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "同意してAIを使う" }));
}

describe("Web AI consent live journey (loopback Local LLM)", () => {
  let server: LoopbackServer | null = null;

  beforeEach(() => {
    localStorage.clear();
    declineActiveAiDataConsent();
  });

  afterEach(async () => {
    cleanup();
    declineActiveAiDataConsent();
    localStorage.clear();
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("refuses before HTTP, allows after consent, and re-consents on destination change", async () => {
    server = await startLoopbackLlm();
    const user = userEvent.setup();
    render(<AiDataConsentGate />);

    // Default BrowserMock authorizer + real browser-ai transport (no stubs).
    const mock = await createBrowserMock();
    await configureCompatibleEndpoint(mock, {
      id: "loop-a",
      label: "Loop A",
      baseUrl: server.baseUrlA,
    });

    expect(server.requestCount()).toBe(0);

    const refused = mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "consent-refuse" }],
      auditContext: await prepareAuditedDispatch(mock, "consent-refuse"),
    });
    const refusedExpectation = expect(refused).rejects.toThrow(
      "ai-data-consent-required",
    );

    expect(
      await screen.findByRole("dialog", { name: "AIで処理する前に確認" }),
    ).toBeTruthy();
    expect(server.requestCount()).toBe(0);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "今は使わない" }));
    });
    await refusedExpectation;
    expect(server.requestCount()).toBe(0);

    const approved = mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "consent-approve" }],
      auditContext: await prepareAuditedDispatch(mock, "consent-approve"),
    });
    expect(server.requestCount()).toBe(0);
    await acceptVisibleConsent(user);
    await expect(approved).resolves.toMatchObject({
      blocks: [{ type: "text", content: "loopback-ok" }],
    });
    expect(server.requestCount()).toBe(1);
    const afterApprove = server.requestCount();

    await configureCompatibleEndpoint(mock, {
      id: "loop-b",
      label: "Loop B",
      baseUrl: server.baseUrlB,
    });

    const reconsentRefused = mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "consent-reconsent-refuse" }],
      auditContext: await prepareAuditedDispatch(
        mock,
        "consent-reconsent-refuse",
      ),
    });
    const reconsentExpectation = expect(reconsentRefused).rejects.toThrow(
      "ai-data-consent-required",
    );
    expect(
      await screen.findByRole("dialog", { name: "AIで処理する前に確認" }),
    ).toBeTruthy();
    expect(server.requestCount()).toBe(afterApprove);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "今は使わない" }));
    });
    await reconsentExpectation;
    expect(server.requestCount()).toBe(afterApprove);

    const artifactRoot = path.join(
      repoRoot,
      ".artifacts",
      "web-ai-consent-live",
    );
    await mkdir(artifactRoot, { recursive: true });
    const report = {
      schemaVersion: 1,
      mode: "web-ai-consent-live",
      certificationEligible: true,
      requestCountBeforeConsent: 0,
      requestCountAfterRefuse: 0,
      requestCountAfterApprove: afterApprove,
      requestCountAfterDestinationChangeRefuse: server.requestCount(),
      accessLogDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(server.accessLog))
        .digest("hex")}`,
      endpoints: {
        a: server.baseUrlA,
        b: server.baseUrlB,
      },
      teardown: {
        localStorageCleared: true,
        serverClosed: false,
      },
    };
    await writeFile(
      path.join(artifactRoot, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    mock.close();
    await server.close();
    server = null;
    localStorage.clear();
    declineActiveAiDataConsent();
  }, 60_000);
});
