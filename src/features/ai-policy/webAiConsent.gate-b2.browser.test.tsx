import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserMock } from "@/lib/browser-mock";
import { AiDataConsentGate } from "./AiDataConsentGate";
import { declineActiveAiDataConsent } from "./aiDataConsentBroker";

declare const __GATE_B2_PROVIDER_BASE_URL__: string;
declare const __GATE_B2_PROVIDER_STATS_URL__: string;
declare const __GATE_B2_EVIDENCE_URL__: string;

interface ProviderStats {
  readonly chatRequestCount: number;
}

interface BrowserJourneyEvidence {
  readonly result: "passed";
  readonly assertions: readonly string[];
  readonly requestCountBeforeConsent: number;
  readonly requestCountAfterRefuse: number;
  readonly requestCountAfterApprove: number;
  readonly requestCountAfterDestinationChangeRefuse: number;
  readonly localStorageCleared: boolean;
  readonly indexedDbCleared: boolean;
  readonly consentBrokerDeclined: boolean;
  readonly browserMockClosed: boolean;
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

async function readProviderStats(): Promise<ProviderStats> {
  const response = await fetch(__GATE_B2_PROVIDER_STATS_URL__);
  if (!response.ok) {
    throw new Error(`provider stats failed: ${response.status}`);
  }
  return (await response.json()) as ProviderStats;
}

async function acceptVisibleConsent(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", {
    name: "AIで処理する前に確認",
  });
  expect(dialog).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "同意してAIを使う" }));
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("sentinel");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedTeardownStorage(): Promise<string> {
  const databaseName = `gate-b2-consent-${crypto.randomUUID()}`;
  const database = await openDatabase(databaseName);
  const transaction = database.transaction("sentinel", "readwrite");
  transaction.objectStore("sentinel").put("present", "state");
  await transactionComplete(transaction);
  database.close();
  localStorage.setItem("gate-b2-consent-teardown", "present");
  return databaseName;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error(`IndexedDB delete blocked: ${name}`));
  });
}

async function databaseExists(name: string): Promise<boolean> {
  const databases = await indexedDB.databases();
  return databases.some((database) => database.name === name);
}

async function cleanupBrowserStorage(databaseName: string) {
  await deleteDatabase(databaseName);
  localStorage.clear();
  return {
    localStorageCleared: localStorage.length === 0,
    indexedDbCleared: !(await databaseExists(databaseName)),
  };
}

async function postEvidence(evidence: BrowserJourneyEvidence): Promise<void> {
  const response = await fetch(__GATE_B2_EVIDENCE_URL__, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evidence),
  });
  if (!response.ok) {
    throw new Error(`Gate B2 evidence receiver failed: ${response.status}`);
  }
}

describe("Gate B2 Web AI consent journey (real Chromium)", () => {
  beforeEach(() => {
    localStorage.clear();
    declineActiveAiDataConsent();
  });

  afterEach(() => {
    cleanup();
    declineActiveAiDataConsent();
    localStorage.clear();
  });

  it("proves consent, destination binding, and browser storage teardown", async () => {
    const databaseName = await seedTeardownStorage();
    const user = userEvent.setup();
    const mock = await createBrowserMock();
    let mockClosed = false;

    try {
      render(<AiDataConsentGate />);
      const endpointA = `${__GATE_B2_PROVIDER_BASE_URL__}/consent-a/v1`;
      const endpointB = `${__GATE_B2_PROVIDER_BASE_URL__}/consent-b/v1`;
      await configureCompatibleEndpoint(mock, {
        id: "loop-a",
        label: "Loop A",
        baseUrl: endpointA,
      });

      const beforeConsent = await readProviderStats();
      expect(beforeConsent.chatRequestCount).toBe(0);

      const refused = mock.invoke("send_chat_message", {
        messages: [{ role: "user", content: "consent-refuse" }],
        auditContext: await prepareAuditedDispatch(mock, "consent-refuse"),
      });
      const refusedExpectation = expect(refused).rejects.toThrow(
        "ai-data-consent-required",
      );
      await screen.findByRole("dialog", { name: "AIで処理する前に確認" });
      expect((await readProviderStats()).chatRequestCount).toBe(0);
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "今は使わない" }));
      });
      await refusedExpectation;
      const afterRefuse = await readProviderStats();
      expect(afterRefuse.chatRequestCount).toBe(0);

      const approved = mock.invoke("send_chat_message", {
        messages: [{ role: "user", content: "consent-approve" }],
        auditContext: await prepareAuditedDispatch(mock, "consent-approve"),
      });
      await acceptVisibleConsent(user);
      await expect(approved).resolves.toMatchObject({
        blocks: [{ type: "text", content: "loopback-ok" }],
      });
      const afterApprove = await readProviderStats();
      expect(afterApprove.chatRequestCount).toBeGreaterThan(0);

      await configureCompatibleEndpoint(mock, {
        id: "loop-b",
        label: "Loop B",
        baseUrl: endpointB,
      });
      const destinationChanged = mock.invoke("send_chat_message", {
        messages: [{ role: "user", content: "consent-destination-change" }],
        auditContext: await prepareAuditedDispatch(
          mock,
          "consent-destination-change",
        ),
      });
      const destinationExpectation = expect(destinationChanged).rejects.toThrow(
        "ai-data-consent-required",
      );
      await screen.findByRole("dialog", { name: "AIで処理する前に確認" });
      const beforeDestinationRefuse = await readProviderStats();
      expect(beforeDestinationRefuse.chatRequestCount).toBe(
        afterApprove.chatRequestCount,
      );
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "今は使わない" }));
      });
      await destinationExpectation;
      const afterDestinationRefuse = await readProviderStats();
      expect(afterDestinationRefuse.chatRequestCount).toBe(
        afterApprove.chatRequestCount,
      );

      mock.close();
      mockClosed = true;
      const storage = await cleanupBrowserStorage(databaseName);
      const evidence: BrowserJourneyEvidence = {
        result: "passed",
        assertions: [
          "refusal-before-provider-is-zero-http",
          "approval-dispatches-provider-http",
          "destination-change-requires-fresh-consent",
          "indexeddb-and-localstorage-are-cleared",
          "browser-mock-is-closed-before-evidence",
        ],
        requestCountBeforeConsent: beforeConsent.chatRequestCount,
        requestCountAfterRefuse: afterRefuse.chatRequestCount,
        requestCountAfterApprove: afterApprove.chatRequestCount,
        requestCountAfterDestinationChangeRefuse:
          afterDestinationRefuse.chatRequestCount,
        ...storage,
        consentBrokerDeclined: true,
        browserMockClosed: mockClosed,
      };
      await postEvidence(evidence);
    } finally {
      if (!mockClosed) mock.close();
    }
  }, 60_000);
});
