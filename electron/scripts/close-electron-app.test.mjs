import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  MAX_QUIESCENCE_DIAGNOSTICS,
  closeElectronAppWithDiagnostics,
  sanitizeQuiescenceDiagnostics,
} from "./close-electron-app.mjs";

const GLOBAL_DIAGNOSTICS_KEY = "__grimodexQuiescenceDiagnostics";

function diagnostic(overrides = {}) {
  return {
    closePhase: "strict-quiescence",
    stage: "scoped-mutations",
    providerId: "settings",
    errorName: "StrictQuiescenceError",
    ipcCode: "IPC_TIMEOUT",
    outcome: "failed",
    ...overrides,
  };
}

class FakeElectronProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }
}

function pendingPromise() {
  return new Promise(() => {});
}

test("quiescence diagnostics keep only the bounded allowlisted projection", () => {
  const input = [
    diagnostic({
      message: "do-not-export-message-secret",
      stack: "do-not-export-stack-secret",
      cause: { message: "do-not-export-cause-secret" },
      details: { secret: "do-not-export-object-secret" },
    }),
  ];

  const result = sanitizeQuiescenceDiagnostics(input);

  assert.deepEqual(result, [diagnostic()]);
  assert.equal(JSON.stringify(result).includes("do-not-export"), false);
  assert.deepEqual(
    new Set(Object.keys(result[0])),
    new Set([
      "closePhase",
      "stage",
      "providerId",
      "errorName",
      "ipcCode",
      "outcome",
    ]),
  );
});

test("genesis barrier and authority phase allowlists reject lookalikes", () => {
  const genesis = diagnostic({
    closePhase: "genesis-prelude",
    errorName: "TimelapseGenesisBarrierError",
  });
  const authority = diagnostic({
    closePhase: "authority-quiescence",
    errorName: "Error",
  });

  assert.deepEqual(
    sanitizeQuiescenceDiagnostics([
      genesis,
      authority,
      { ...genesis, errorName: "TimelapseGenesisBarrierErrorLike" },
      { ...authority, closePhase: "authority-quiescence-like" },
    ]),
    [genesis, authority],
  );
});

test("malformed diagnostics fail closed without preserving arbitrary values", () => {
  const secret = "malformed-message-secret";
  const result = sanitizeQuiescenceDiagnostics([
    { ...diagnostic(), closePhase: { secret } },
    { ...diagnostic(), errorName: secret },
    {
      ...diagnostic(),
      providerId: { secret },
      stage: { secret },
      ipcCode: { secret },
      outcome: { secret },
      message: secret,
    },
  ]);

  assert.deepEqual(result, [
    {
      closePhase: "strict-quiescence",
      errorName: "StrictQuiescenceError",
    },
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("huge diagnostics input is capped to a fixed record count", () => {
  const result = sanitizeQuiescenceDiagnostics(
    Array.from({ length: MAX_QUIESCENCE_DIAGNOSTICS + 100 }, () =>
      diagnostic(),
    ),
  );

  assert.equal(result.length, MAX_QUIESCENCE_DIAGNOSTICS);
});

test("proxy-like and absent diagnostics never throw or leak raw values", () => {
  const throwingRecord = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("proxy-message-secret");
      },
    },
  );
  const revoked = Proxy.revocable([diagnostic()], {});
  revoked.revoke();

  assert.doesNotThrow(() => sanitizeQuiescenceDiagnostics(throwingRecord));
  assert.doesNotThrow(() => sanitizeQuiescenceDiagnostics([throwingRecord]));
  assert.doesNotThrow(() => sanitizeQuiescenceDiagnostics(revoked.proxy));
  assert.deepEqual(sanitizeQuiescenceDiagnostics(throwingRecord), []);
  assert.deepEqual(sanitizeQuiescenceDiagnostics(revoked.proxy), []);
  assert.deepEqual(sanitizeQuiescenceDiagnostics(undefined), []);
  assert.deepEqual(sanitizeQuiescenceDiagnostics({ length: 1 }), []);
});

test("close timeout diagnostics include only the sanitized page projection", async () => {
  const childProcess = new FakeElectronProcess();
  const previousGlobal = Object.getOwnPropertyDescriptor(
    globalThis,
    GLOBAL_DIAGNOSTICS_KEY,
  );
  Object.defineProperty(globalThis, GLOBAL_DIAGNOSTICS_KEY, {
    configurable: true,
    value: [
      diagnostic({
        message: "close-timeout-message-secret",
        stack: "close-timeout-stack-secret",
        cause: { message: "close-timeout-cause-secret" },
      }),
      diagnostic({
        closePhase: "genesis-prelude",
        errorName: "TimelapseGenesisBarrierError",
        message: "genesis-message-secret",
        stack: "genesis-stack-secret",
      }),
      diagnostic({
        closePhase: "authority-quiescence",
        errorName: "Error",
        message: "authority-message-secret",
      }),
      {
        closePhase: "not-allowed",
        errorName: "Error",
        message: "malformed-secret",
      },
    ],
  });

  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousPerformance = globalThis.performance;
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    dispatchEvent: () => false,
  };
  globalThis.performance = {
    getEntriesByType: () => [],
  };

  try {
    await assert.rejects(
      closeElectronAppWithDiagnostics(
        {
          process: () => childProcess,
          close: pendingPromise,
        },
        {
          isClosed: () => false,
          evaluate: async (callback) => callback(),
        },
        "restart",
        {
          timeoutMs: 5,
          processExitGraceMs: 5,
          pageDiagnosticsTimeoutMs: 50,
        },
      ),
      (error) => {
        const prefix = "restart app close timed out: ";
        assert.match(error.message, new RegExp(`^${prefix}`));
        const payload = JSON.parse(error.message.slice(prefix.length));
        assert.deepEqual(payload.quiescenceDiagnostics, [
          diagnostic(),
          diagnostic({
            closePhase: "genesis-prelude",
            errorName: "TimelapseGenesisBarrierError",
          }),
          diagnostic({
            closePhase: "authority-quiescence",
            errorName: "Error",
          }),
        ]);
        assert.equal(JSON.stringify(payload).includes("close-timeout-"), false);
        assert.equal(
          JSON.stringify(payload).includes("genesis-message-secret"),
          false,
        );
        assert.equal(
          JSON.stringify(payload).includes("genesis-stack-secret"),
          false,
        );
        assert.equal(
          JSON.stringify(payload).includes("authority-message-secret"),
          false,
        );
        return true;
      },
    );
  } finally {
    if (previousGlobal) {
      Object.defineProperty(globalThis, GLOBAL_DIAGNOSTICS_KEY, previousGlobal);
    } else {
      delete globalThis[GLOBAL_DIAGNOSTICS_KEY];
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousPerformance === undefined) {
      delete globalThis.performance;
    } else {
      globalThis.performance = previousPerformance;
    }
  }
});
