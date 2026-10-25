// Synthetic receipts only. SHA256SUMS tests write to a fresh temp directory.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { K62_FREEZE } from "./constants.mjs";
import {
  CP4_RECEIPT_SCHEMA,
  assertCp4Receipt,
  assertDeclarationCurrent,
  assertElectronLaunch,
  assessMeasurementWindow,
  formatSha256Sums,
  parseSha256Sums,
  selectReceiptsForAggregation,
  validateCp4Receipt,
  verifySha256Sums,
  writeSha256Sums,
} from "./receipt.mjs";

const H40 = (c) => c.repeat(40);
const H64 = (c) => c.repeat(64);

function indexMeta(generation = 3, dirty = false) {
  return {
    b: { generation, dirty },
    chronicle: { generation: generation + 1, dirty },
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: CP4_RECEIPT_SCHEMA,
    runId: "cp4-dev-1",
    runKind: "g-case-gold",
    preview: false,
    head: {
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      runStartedAtUtc: "2026-10-25T01:02:03.456Z",
      observationPrep: { commit: H40("a"), freezeRecordSha256: H64("b") },
      traceFile: null,
    },
    candidate: {
      commit: H40("c"),
      tree: H40("d"),
      clean: true,
      productReceiptSha256: H64("e"),
      evalReceiptSha256: H64("f"),
      workerSha256: H64("1"),
      features: ["nir1-graph-eval"],
      models: {
        ja: { modelSha256: H64("2"), tokenizerSha256: H64("3") },
        en: { modelSha256: H64("4"), tokenizerSha256: H64("5") },
      },
      electronVersion: "39.0.0",
      harnessFiles: {
        "scripts/quality/nir1-graph-eval/availability.mjs": H64("6"),
      },
    },
    environment: {
      hostSnapshot: { loadavg: [0.1, 0.1, 0.1] },
      windowSamples: [],
      windowAssessment: { clean: true, violations: [], gaps: [] },
      xvfbDisplay: ":99",
      removedEnv: [
        "WAYLAND_DISPLAY",
        "WAYLAND_SOCKET",
        "DBUS_SESSION_BUS_ADDRESS",
      ],
      netLog: { sha256: H64("7"), nonLoopbackAttempts: 0 },
      socketSamples: [],
    },
    settings: {
      variantKey: "G-03/base",
      d2aModes: {
        raw: "restricted",
        hybrid: "restricted",
        graph: "restricted",
      },
      reauthorization: { totalMs: 1.5 },
      setupReceipt: { logicalToRuntime: { "dev-a": "rt-1" } },
    },
    samples: [{ trigger: "user-operation" }],
    requeries: [{ trigger: "graph-ready-requery" }],
    aggregates: { a: {} },
    verdict: { outcome: "hold" },
    ...overrides,
  };
}

function declaration(overrides = {}) {
  return {
    workspaceId: "ws-1",
    canonicalLocatorDigest: H64("8"),
    token: "decl-token",
    bindingDigest: H64("9"),
    seamReceipt: {
      version: "cb2-body-declaration-ci-seam/1",
      envNames: [
        "CI",
        "GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN",
        "GRIMODEX_BODY_DECLARATION_CI_NONCE",
      ],
      nonceDigest: H64("a"),
      approvedGrantCount: 1,
      bindingDigest: H64("9"),
    },
    indexBefore: indexMeta(),
    indexAfter: indexMeta(),
    verified: true,
    ...overrides,
  };
}

test("P-10: a complete receipt passes and its head carries the K6/2 freeze", () => {
  assert.deepEqual(validateCp4Receipt(receipt()), []);
  assert.doesNotThrow(() => assertCp4Receipt(receipt()));
  const { k62, ...noFreeze } = receipt().head;
  assert.ok(k62);
  assert.match(
    validateCp4Receipt(receipt({ head: noFreeze })).join(),
    /freezeCommit/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({
        head: { ...receipt().head, k62: { ...k62, sha256: H64("0") } },
      }),
    ).join(),
    /K6\/2 bytes/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({
        head: { ...receipt().head, runStartedAtUtc: "2026-10-25 01:02" },
      }),
    ).join(),
    /ISO UTC/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({ head: { ...receipt().head, observationPrep: null } }),
    ).join(),
    /observationPrep/,
  );
  // A trace run must also name its frozen trace file.
  assert.match(
    validateCp4Receipt(receipt({ runKind: "trace" })).join(),
    /traceFile/,
  );
  assert.deepEqual(
    validateCp4Receipt(
      receipt({
        runKind: "trace",
        head: {
          ...receipt().head,
          traceFile: { commit: H40("b"), sha256: H64("c") },
        },
      }),
    ),
    [],
  );
  assert.throws(
    () => assertCp4Receipt(receipt({ schemaVersion: "x" })),
    /\[precheck\]/,
  );
});

test("the receipt keeps re-queries in their own column and the Graph arm restricted", () => {
  assert.match(
    validateCp4Receipt(
      receipt({ samples: [{ trigger: "graph-ready-requery" }] }),
    ).join(),
    /re-query rows/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({ requeries: [{ trigger: "user-operation" }] }),
    ).join(),
    /requeries must not hold/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({
        settings: {
          ...receipt().settings,
          d2aModes: { hybrid: "restricted", graph: "unrestricted" },
        },
      }),
    ).join(),
    /restricted \(D10\)/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({ candidate: { ...receipt().candidate, clean: false } }),
    ).join(),
    /clean/,
  );
  assert.match(
    validateCp4Receipt(
      receipt({ settings: { ...receipt().settings, variantKey: "G-09/base" } }),
    ).join(),
    /unknown CP-4 variant/,
  );
});

test("a declaration variant's receipt carries the K2/4 declaration record", () => {
  const declared = receipt({
    settings: { ...receipt().settings, variantKey: "G-02/base" },
  });
  assert.match(validateCp4Receipt(declared).join(), /declaration\.workspaceId/);
  assert.deepEqual(
    validateCp4Receipt({ ...declared, declaration: declaration() }),
    [],
  );
  assert.match(
    validateCp4Receipt({
      ...declared,
      declaration: declaration({ verified: false }),
    }).join(),
    /verified/,
  );
});

test("P-3 / N-5 / N-6: only a current declaration with unchanged Index metadata proceeds", () => {
  const workspace = {
    workspaceId: "ws-1",
    canonicalLocatorDigest: H64("8"),
    bindingDigest: H64("9"),
  };
  assert.deepEqual(
    assertDeclarationCurrent({
      declaration: declaration(),
      measurementWorkspace: workspace,
    }),
    { proceed: true },
  );
  for (const field of [
    "workspaceId",
    "canonicalLocatorDigest",
    "bindingDigest",
  ]) {
    assert.throws(
      () =>
        assertDeclarationCurrent({
          declaration: declaration(),
          measurementWorkspace: { ...workspace, [field]: "other" },
        }),
      (error) =>
        /\[precheck\].*not current/.test(error.message) &&
        !/blocked/.test(error.message),
      field,
    );
  }
  assert.throws(
    () =>
      assertDeclarationCurrent({
        declaration: declaration({ indexAfter: indexMeta(4) }),
        measurementWorkspace: workspace,
      }),
    /\[precheck\] b Index generation changed/,
  );
  assert.throws(
    () =>
      assertDeclarationCurrent({
        declaration: declaration({ indexAfter: indexMeta(3, true) }),
        measurementWorkspace: workspace,
      }),
    /\[precheck\] b Index dirty changed/,
  );
  assert.throws(
    () =>
      assertDeclarationCurrent({
        declaration: declaration({ indexBefore: null }),
        measurementWorkspace: workspace,
      }),
    /\[precheck\] declaration record incomplete/,
  );
});

function windowSamples(times, extra = {}) {
  return times.map((atMs) => ({
    atMs,
    heavySlotsInUse: 0,
    buildProcesses: [],
    otherMeasurements: [],
    ...extra,
  }));
}

test("D3 / N-14: window violations and gaps exclude a run but keep it", () => {
  const run = { startedAtMs: 1_000, finishedAtMs: 61_000 };
  const clean = assessMeasurementWindow({
    samples: windowSamples([0, 20_000, 40_000, 62_000]),
    run,
  });
  assert.deepEqual(clean, { clean: true, violations: [], gaps: [] });
  const heavy = assessMeasurementWindow({
    samples: windowSamples([0, 20_000, 40_000, 62_000]).map((row, at) =>
      at === 2 ? { ...row, heavySlotsInUse: 1 } : row,
    ),
    run,
  });
  assert.equal(heavy.clean, false);
  assert.match(heavy.violations.join(), /heavy slot/);
  const own = assessMeasurementWindow({
    samples: windowSamples([0, 20_000, 62_000], {
      buildProcesses: [{ pid: 42, command: "vite build" }],
    }),
    run,
    ownPids: [42],
  });
  assert.equal(own.clean, false);
  assert.match(own.gaps.join(), /too far apart/);
  assert.equal(
    assessMeasurementWindow({
      samples: windowSamples([0, 20_000, 40_000, 62_000], {
        buildProcesses: [{ pid: 42, command: "vite build" }],
      }),
      run,
      ownPids: [42],
    }).clean,
    true,
  );
  assert.match(
    assessMeasurementWindow({
      samples: windowSamples([2_000, 20_000, 40_000, 62_000]),
      run,
    }).gaps.join(),
    /before the run/,
  );
  const kept = selectReceiptsForAggregation([
    { runId: "ok", environment: { windowAssessment: clean } },
    { runId: "heavy", environment: { windowAssessment: heavy } },
    { runId: "missing", environment: {} },
  ]);
  assert.deepEqual(
    kept.included.map((row) => row.runId),
    ["ok"],
  );
  assert.deepEqual(
    kept.excluded.map((row) => [row.runId, row.reason]),
    [
      ["heavy", "measurement-window-requirement-not-met"],
      ["missing", "measurement-window-requirement-not-met"],
    ],
  );
});

test("N-11: Electron launches without Wayland or session D-Bus and outside a netns", () => {
  const env = {
    DISPLAY: ":99",
    XDG_SESSION_TYPE: "x11",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
  };
  assert.deepEqual(
    assertElectronLaunch({ env, argv: ["node", "electron"] }).removedEnv,
    ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS"],
  );
  for (const name of [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    assert.throws(
      () => assertElectronLaunch({ env: { ...env, [name]: "x" } }),
      /\[precheck\]/,
    );
  assert.throws(
    () =>
      assertElectronLaunch({ env: { ...env, XDG_SESSION_TYPE: "wayland" } }),
    /Wayland/,
  );
  assert.throws(
    () =>
      assertElectronLaunch({
        env: { ...env, ELECTRON_OZONE_PLATFORM_HINT: undefined },
      }),
    /ozone/,
  );
  assert.throws(
    () =>
      assertElectronLaunch({ env, argv: ["/usr/bin/unshare", "-rn", "Xvfb"] }),
    /network namespace/,
  );
  assert.throws(
    () => assertElectronLaunch({ env, argv: ["ip", "netns", "exec", "x"] }),
    /network namespace/,
  );
});

test("SHA256SUMS is sha256sum -c compatible and detects tampering", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cp4-sums-"));
  try {
    await writeFile(path.join(directory, "receipt.json"), "{}\n");
    await writeFile(path.join(directory, "manifest.json"), "[]\n");
    const text = await writeSha256Sums(directory, [
      "receipt.json",
      "manifest.json",
    ]);
    assert.equal(
      text,
      "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570  manifest.json\n" +
        "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  receipt.json\n",
    );
    assert.deepEqual(
      parseSha256Sums(text).map((row) => row.path),
      ["manifest.json", "receipt.json"],
    );
    assert.deepEqual(await verifySha256Sums(directory, text), {
      ok: true,
      mismatched: [],
      missing: [],
    });
    await writeFile(path.join(directory, "receipt.json"), '{"x":1}\n');
    await rm(path.join(directory, "manifest.json"));
    assert.deepEqual(await verifySha256Sums(directory, text), {
      ok: false,
      mismatched: ["receipt.json"],
      missing: ["manifest.json"],
    });
    await assert.rejects(
      writeSha256Sums(directory, ["receipt.json"]),
      /EEXIST/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(
    () => formatSha256Sums([{ path: "../x", sha256: H64("a") }]),
    /unsafe/,
  );
  assert.throws(
    () => formatSha256Sums([{ path: "/abs", sha256: H64("a") }]),
    /unsafe/,
  );
  assert.throws(
    () => formatSha256Sums([{ path: "SHA256SUMS", sha256: H64("a") }]),
    /itself/,
  );
  assert.throws(
    () =>
      formatSha256Sums([
        { path: "a", sha256: H64("a") },
        { path: "a", sha256: H64("b") },
      ]),
    /duplicate/,
  );
  assert.throws(() => parseSha256Sums("nothex  file\n"), /malformed/);
});
