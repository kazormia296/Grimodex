import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  MAX_QUIESCENCE_DIAGNOSTICS,
  closeElectronAppWithDiagnostics,
  isElectronPostExitCloseError,
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
    this.kill = () => {
      this.killed = true;
      return true;
    };
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

test("close reuses the launch-captured child after Playwright disposal", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  let processCalls = 0;
  let closeCalls = 0;
  const app = {
    process: () => {
      processCalls += 1;
      if (processCalls > 1) {
        throw new TypeError(
          "Cannot read properties of undefined (reading '_object')",
        );
      }
      return childProcess;
    },
    close: async () => {
      closeCalls += 1;
    },
  };
  const capturedChild = app.process();

  await closeElectronAppWithDiagnostics(app, null, "interrupted", {
    childProcess: capturedChild,
  });

  assert.equal(processCalls, 1);
  assert.equal(closeCalls, 1);
});

test("close can surface a typed post-exit disposal outcome without reacquiring app.process", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  let processCalls = 0;
  const app = {
    process: () => {
      processCalls += 1;
      if (processCalls > 1) {
        throw new TypeError("disposed app.process");
      }
      return childProcess;
    },
    close: async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading '_object')",
      );
    },
  };

  const capturedChild = app.process();
  await assert.rejects(
    closeElectronAppWithDiagnostics(app, null, "interrupted", {
      childProcess: capturedChild,
      throwOnPostExitCloseError: true,
    }),
    (error) => {
      assert.equal(
        isElectronPostExitCloseError(error, app, "interrupted", childProcess),
        true,
      );
      assert.equal(error.name, "ElectronPostExitCloseError");
      assert.equal(
        error.cause?.message,
        "Cannot read properties of undefined (reading '_object')",
      );
      return true;
    },
  );
  assert.equal(processCalls, 1);
});

test("post-exit close awaits delayed Playwright resolution", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  let settledAt = null;
  const startedAt = Date.now();

  await closeElectronAppWithDiagnostics(
    {
      process: () => childProcess,
      close: () =>
        new Promise((resolve) => {
          globalThis.setTimeout(() => {
            settledAt = Date.now();
            resolve();
          }, 25);
        }),
    },
    null,
    "interrupted",
    {
      childProcess,
      throwOnPostExitCloseError: true,
      timeoutMs: 100,
    },
  );

  assert.ok(settledAt !== null);
  assert.ok(settledAt - startedAt >= 20);
});

test("post-exit close classifies a delayed real Playwright disposal rejection", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  const disposalMessage =
    "Cannot read properties of undefined (reading '_object')";
  const app = {
    process: () => childProcess,
    close: () =>
      new Promise((_, reject) => {
        globalThis.setTimeout(() => reject(new TypeError(disposalMessage)), 25);
      }),
  };

  await assert.rejects(
    closeElectronAppWithDiagnostics(app, null, "interrupted", {
      childProcess,
      throwOnPostExitCloseError: true,
      timeoutMs: 100,
    }),
    (error) =>
      isElectronPostExitCloseError(error, app, "interrupted", childProcess) &&
      error.cause?.message === disposalMessage,
  );
});

test("post-exit close does not classify a near-match disposal message", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  const app = {
    process: () => childProcess,
    close: async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading '_object') near-match",
      );
    },
  };

  await assert.rejects(
    closeElectronAppWithDiagnostics(app, null, "interrupted", {
      childProcess,
      throwOnPostExitCloseError: true,
      timeoutMs: 100,
    }),
    (error) =>
      !isElectronPostExitCloseError(error, app, "interrupted", childProcess) &&
      error.cause?.message.endsWith("near-match"),
  );
});

test("post-exit close does not classify the exact error while the child is live", async () => {
  const childProcess = new FakeElectronProcess();
  const app = {
    process: () => childProcess,
    close: async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading '_object')",
      );
    },
  };

  await assert.rejects(
    closeElectronAppWithDiagnostics(app, null, "interrupted", {
      childProcess,
      throwOnPostExitCloseError: true,
      timeoutMs: 100,
    }),
    (error) =>
      !isElectronPostExitCloseError(error, app, "interrupted", childProcess) &&
      error.cause?.message.includes("_object"),
  );
});

test("post-exit close predicate rejects a forged lookalike", () => {
  const childProcess = new FakeElectronProcess();
  const forged = Object.freeze({
    name: "ElectronPostExitCloseError",
    phase: "interrupted",
    childProcess,
  });

  assert.equal(
    isElectronPostExitCloseError(forged, {}, "interrupted", childProcess),
    false,
  );
});

test("post-exit close rejects a delayed non-Playwright error", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  const app = {
    process: () => childProcess,
    close: () =>
      new Promise((_, reject) => {
        globalThis.setTimeout(
          () => reject(new TypeError("unrelated close failure")),
          25,
        );
      }),
  };

  await assert.rejects(
    closeElectronAppWithDiagnostics(app, null, "interrupted", {
      childProcess,
      throwOnPostExitCloseError: true,
      timeoutMs: 100,
    }),
    (error) =>
      !isElectronPostExitCloseError(error, app, "interrupted", childProcess) &&
      error.cause?.message === "unrelated close failure",
  );
});

test("post-exit close treats a hanging Playwright close as a timeout", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  const app = {
    process: () => childProcess,
    close: pendingPromise,
  };

  await assert.rejects(
    closeElectronAppWithDiagnostics(app, null, "interrupted", {
      childProcess,
      throwOnPostExitCloseError: true,
      timeoutMs: 10,
      pageDiagnosticsTimeoutMs: 10,
    }),
    (error) =>
      error.message.startsWith("interrupted app close timed out:") &&
      !isElectronPostExitCloseError(error, app, "interrupted", childProcess),
  );
});

test("close can skip process lookup when no child was captured", async () => {
  let processCalls = 0;
  let closeCalls = 0;
  const app = {
    process: () => {
      processCalls += 1;
      throw new TypeError("disposed app.process");
    },
    close: async () => {
      closeCalls += 1;
    },
  };

  await closeElectronAppWithDiagnostics(app, null, "late-launch", {
    childProcess: undefined,
    skipProcessLookup: true,
  });

  assert.equal(processCalls, 0);
  assert.equal(closeCalls, 1);
});

test("close rejects malformed child handles before observing or closing", async () => {
  const malformedChildren = [
    {},
    {
      once() {},
      removeListener() {},
      kill() {},
      exitCode: null,
      signalCode: null,
    },
    {
      pid: 1234,
      once() {},
      removeListener() {},
      kill() {},
      exitCode: undefined,
      signalCode: null,
    },
    {
      pid: 0,
      once() {},
      removeListener() {},
      kill() {},
      exitCode: null,
      signalCode: null,
    },
    {
      pid: 1234,
      once: null,
      removeListener() {},
      kill() {},
      exitCode: null,
      signalCode: null,
    },
    {
      pid: 1234,
      once() {},
      removeListener: null,
      kill() {},
      exitCode: null,
      signalCode: null,
    },
    {
      pid: 1234,
      once() {},
      removeListener() {},
      kill: null,
      exitCode: null,
      signalCode: null,
    },
    {
      pid: 1234,
      once() {},
      removeListener() {},
      kill() {},
      exitCode: "0",
      signalCode: null,
    },
    {
      pid: 1234,
      once() {},
      removeListener() {},
      kill() {},
      exitCode: null,
      signalCode: undefined,
    },
    {
      pid: 1234,
      once() {},
      removeListener() {},
      kill() {},
      exitCode: null,
      signalCode: { value: "SIGTERM" },
    },
  ];

  for (const childProcess of malformedChildren) {
    let closeCalls = 0;
    let observeCalls = 0;
    const candidate = {
      process: () => childProcess,
      close: async () => {
        closeCalls += 1;
      },
    };
    if (typeof childProcess.once === "function") {
      const originalOnce = childProcess.once;
      childProcess.once = (...args) => {
        observeCalls += 1;
        return originalOnce.apply(childProcess, args);
      };
    }

    await assert.rejects(
      closeElectronAppWithDiagnostics(candidate, null, "malformed-child", {
        timeoutMs: 5,
      }),
      /invalid|malformed child process/,
    );
    assert.equal(closeCalls, 0);
    assert.equal(observeCalls, 0);
  }
});

test("close removes an exit listener when observer setup throws synchronously", async () => {
  const childProcess = new FakeElectronProcess();
  let removeCalls = 0;
  childProcess.once = () => {
    throw new Error("observer setup failed");
  };
  childProcess.removeListener = () => {
    removeCalls += 1;
  };
  let closeCalls = 0;

  await assert.rejects(
    closeElectronAppWithDiagnostics(
      {
        process: () => childProcess,
        close: async () => {
          closeCalls += 1;
        },
      },
      null,
      "observer-setup",
    ),
    /observer setup failed/,
  );
  assert.equal(removeCalls, 1);
  assert.equal(closeCalls, 0);
});

test("post-exit close times out fatally and normalizes a later rejection", async () => {
  const childProcess = new FakeElectronProcess();
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  const app = {
    process: () => childProcess,
    close: () =>
      new Promise((_, reject) => {
        globalThis.setTimeout(
          () => reject(new Error("late close rejection")),
          30,
        );
      }),
  };
  let unhandledRejections = 0;
  const onUnhandledRejection = () => {
    unhandledRejections += 1;
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await assert.rejects(
      closeElectronAppWithDiagnostics(app, null, "interrupted", {
        childProcess,
        throwOnPostExitCloseError: true,
        timeoutMs: 5,
        pageDiagnosticsTimeoutMs: 5,
      }),
      (error) =>
        error.message.startsWith("interrupted app close timed out:") &&
        !isElectronPostExitCloseError(error, app, "interrupted", childProcess),
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  assert.equal(unhandledRejections, 0);
});
