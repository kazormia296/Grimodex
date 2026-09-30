import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcInvokeError } from "@/lib/tauri";
import { createQuiescenceProviderId } from "@/lib/quiescenceProviders";
import {
  clearQuiescenceDiagnostics,
  getQuiescenceDiagnostics,
  projectQuiescenceDiagnostic,
  publishCloseQuiescenceDiagnostics,
} from "./quiescenceDiagnostics";

afterEach(() => {
  clearQuiescenceDiagnostics();
  vi.restoreAllMocks();
});

describe("quiescence diagnostics projection", () => {
  it("publishes only allowlisted fields and never serializes error payloads", () => {
    const secret = "SECRET_PATH_BODY_MESSAGE_STACK_CAUSE";
    const cause = new Error(`cause ${secret}`);
    cause.stack = `stack ${secret}`;
    const error = new IpcInvokeError(
      "secret-command",
      {
        code: "IPC_TIMEOUT",
        message: `message ${secret}`,
        retryable: false,
        outcome: "unknown",
        details: {
          workspacePath: secret,
          body: secret,
        },
      },
      cause,
    );
    const diagnostic = projectQuiescenceDiagnostic({
      closePhase: "native-close",
      stage: "ipc-actual-tasks",
      providerId: createQuiescenceProviderId("ipc-actual-tasks"),
      originalError: error,
    });

    expect(diagnostic).toEqual({
      closePhase: "native-close",
      stage: "ipc-actual-tasks",
      providerId: "ipc-actual-tasks",
      errorName: "IpcInvokeError",
      ipcCode: "IPC_TIMEOUT",
      outcome: "unknown",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(Object.keys(diagnostic).sort()).toEqual([
      "closePhase",
      "errorName",
      "ipcCode",
      "outcome",
      "providerId",
      "stage",
    ]);
  });

  it("is total for revoked proxies and bounded for huge nested error arrays", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() =>
      projectQuiescenceDiagnostic({
        closePhase: "strict-quiescence",
        originalError: revoked.proxy,
      }),
    ).not.toThrow();

    const nested = new AggregateError(
      Array.from({ length: 10_000 }, (_, index) => ({
        cause: { errors: [{ cause: { errors: [{ index }] } }] },
      })),
      "secret aggregate",
    );
    expect(() =>
      projectQuiescenceDiagnostic({
        closePhase: "strict-quiescence",
        originalError: nested,
      }),
    ).not.toThrow();
    expect(
      projectQuiescenceDiagnostic({
        closePhase: "strict-quiescence",
        originalError: nested,
      }),
    ).toMatchObject({
      closePhase: "strict-quiescence",
      errorName: "AggregateError",
    });
  });

  it("keeps diagnostic publication best-effort and exposes no record after clear", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretError = new Error("secret path/body/message");
    publishCloseQuiescenceDiagnostics("strict-quiescence", secretError);

    expect(getQuiescenceDiagnostics()).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("secret path");

    clearQuiescenceDiagnostics();
    expect(getQuiescenceDiagnostics()).toEqual([]);
  });

  it("does not expose unknown names/codes/outcomes", () => {
    const error = Object.assign(new Error("hidden"), {
      code: "SECRET_CODE",
      outcome: "SECRET_OUTCOME",
    });
    expect(
      projectQuiescenceDiagnostic({
        closePhase: "genesis-prelude",
        stage: "not-a-stage" as never,
        providerId: "bad/id" as never,
        originalError: error,
      }),
    ).toEqual({
      closePhase: "genesis-prelude",
      errorName: "Error",
    });
  });
});
