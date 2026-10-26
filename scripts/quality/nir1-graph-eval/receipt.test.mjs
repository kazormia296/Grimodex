// Synthetic receipts only. SHA256SUMS tests write to a fresh temp directory.
import assert from "node:assert/strict";
import { SOCKET_SAMPLE_SCHEMA } from "./egress.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FROZEN_FIXTURE_SHA256,
  K62_FREEZE,
  K64_FREEZE,
  variantByKey,
} from "./constants.mjs";
import {
  CP4_RECEIPT_SCHEMA,
  assertCp4Receipt,
  assertDeclarationCurrent,
  assertElectronLaunch,
  assessMeasurementWindow,
  computeRunAggregates,
  formatSha256Sums,
  parseSha256Sums,
  selectReceiptsForAggregation,
  validateCp4Receipt,
  verifySha256Sums,
  writeSha256Sums,
} from "./receipt.mjs";
import {
  H40,
  H64,
  followUpRecord,
  k64Sample,
  ratification5,
  sample,
  scheduleRows,
} from "./test-support.mjs";

function indexMeta(generation = 3, dirty = false) {
  return {
    b: { generation, dirty },
    chronicle: { generation: generation + 1, dirty },
  };
}

function windowSamples(times, extra = {}) {
  return times.map((atMs) => ({
    atMs,
    locksReadable: true,
    heavySlotFiles: 3,
    heavySlotsInUse: 0,
    buildProcesses: [],
    otherMeasurements: [],
    sameWorktreeBuild: false,
    ...extra,
  }));
}

const RUN = { startedAtMs: 1_000, finishedAtMs: 61_000 };
function socketSamples(times, extra = {}) {
  return times.map((atMs) => ({
    schema: SOCKET_SAMPLE_SCHEMA,
    atMs,
    rootPid: 10,
    pids: [10, 11],
    unreadable: [],
    sockets: { tcp: 2, udp: 0, loopback: 2, unconnected: 0 },
    external: [],
    externalListeners: [],
    unix: { read: true },
    userSessionPeers: [],
    ...extra,
  }));
}
const WORKSPACE = {
  workspaceId: "ws-1",
  canonicalLocatorDigest: H64("8"),
  bindingDigest: H64("9"),
};

function declaration(overrides = {}) {
  return {
    ...WORKSPACE,
    token: "decl-token",
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

/** The K6/4 rows of one variant's AB/BA schedule (R5: the product hook). */
function k64Rows(variant) {
  return scheduleRows([variant]).map((row) =>
    row.arm !== "graph"
      ? row
      : variant.expectedGraph === "unavailable"
        ? {
            ...row,
            followUp: followUpRecord({
              parent: { ticket: null },
              notices: [],
              child: null,
            }),
          }
        : k64Sample({
            variantKey: variant.key,
            phase: row.phase,
            repeat: row.repeat,
          }),
  );
}

/** The K6/4 freeze of a receipt head (批准 7). Pinned by the integrator. */
const K64_HEAD = { freezeCommit: H40("4"), sha256: K64_FREEZE.sha256 };
const FREEZE_PENDING = /K6\/4 freeze commit is not pinned/;
/** Every error but the one the unpinned K6/4 freeze always gives. */
/** The 批准 5 evidence re-collected from git for the fixture's candidate (D-1). */
const BOUND = () => ({ ratification5: ratification5() });
const otherErrors = (value, bound = BOUND()) =>
  validateCp4Receipt(value, bound).filter(
    (error) => !FREEZE_PENDING.test(error),
  );
const K64_SETTINGS = {
  wFMs: 100,
  tLateMs: 100,
  tShowMs: 2_000,
  r1r4WaitMs: 3_000,
  procedureFile: {
    path: "evals/nir1-graph/procedure.v1.json",
    commit: H40("5"),
    sha256: H64("5"),
  },
};

/** A self-consistent receipt; aggregates and window assessment are recomputed. */
function receipt(overrides = {}, { recompute = true } = {}) {
  const variantKey = overrides.settings?.variantKey ?? "G-03/base";
  const variant = variantByKey(variantKey);
  const samples = overrides.samples ?? k64Rows(variant);
  const windowRows = windowSamples([0, 20_000, 40_000, 62_000]);
  const base = {
    schemaVersion: CP4_RECEIPT_SCHEMA,
    runId: "cp4-dev-1",
    runKind: "g-case-gold",
    preview: false,
    run: RUN,
    fixture: {
      path: variant.fixturePath,
      sha256: FROZEN_FIXTURE_SHA256[variant.fixturePath],
      kind: "frozen",
    },
    head: {
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      k64: K64_HEAD,
      runStartedAtUtc: "2026-10-25T01:02:03.456Z",
      observationPrep: { commit: H40("a"), freezeRecordSha256: H64("b") },
      traceFile: null,
    },
    candidate: {
      commit: ratification5().candidateHead,
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
      ratification5: ratification5(),
    },
    environment: {
      hostSnapshot: { loadavg: [0.1, 0.1, 0.1] },
      windowSamples: windowRows,
      ownPids: [],
      windowAssessment: assessMeasurementWindow({
        samples: windowRows,
        run: RUN,
      }),
      xvfbDisplay: ":99",
      removedEnv: [
        "WAYLAND_DISPLAY",
        "WAYLAND_SOCKET",
        "DBUS_SESSION_BUS_ADDRESS",
      ],
      netLog: { sha256: H64("7"), nonLoopbackAttempts: 0, truncated: false },
      socketSamples: socketSamples([0, 20_000, 40_000, 62_000]),
      stop: { closed: true, signalled: [], remaining: [] },
      x11: {
        before: [{ name: "X99", ino: 1 }],
        after: [{ name: "X99", ino: 1 }],
      },
      profileEgress: { dictionaries: [], networkPersistentServers: [] },
      observer: { ok: true, problems: [] },
      mainWorker: {
        ok: true,
        expectedSha256: H64("1"),
        atStart: H64("1"),
        atEnd: H64("1"),
        problems: [],
      },
    },
    settings: {
      variantKey,
      d2aModes: {
        raw: "restricted",
        hybrid: "restricted",
        graph: "restricted",
      },
      reauthorization: { totalMs: 1.5 },
      setupReceipt: { logicalToRuntime: { "dev-a": "rt-1" } },
      k64: K64_SETTINGS,
    },
    samples,
    requeries: [sample({ trigger: "graph-ready-requery", variantKey })],
    verdict: { outcome: "recorded" },
  };
  const merged = {
    ...base,
    ...overrides,
    settings: { ...base.settings, ...overrides.settings },
  };
  if (recompute && overrides.aggregates === undefined)
    merged.aggregates = computeRunAggregates(
      merged,
      variant.kind === "frozen" ? variant : null,
      BOUND(),
    );
  return merged;
}

const errorsOf = (value, bound = BOUND()) =>
  validateCp4Receipt(value, bound).join(" | ");

test("P-10: a complete receipt passes and its head carries the K6/2 freeze", () => {
  assert.deepEqual(otherErrors(receipt()), []);
  const { k62, ...noFreeze } = receipt().head;
  assert.ok(k62);
  assert.match(errorsOf(receipt({ head: noFreeze })), /freezeCommit/);
  assert.match(
    errorsOf(
      receipt({
        head: { ...receipt().head, k62: { ...k62, sha256: H64("0") } },
      }),
    ),
    /K6\/2 bytes/,
  );
  assert.match(
    errorsOf(
      receipt({
        head: { ...receipt().head, runStartedAtUtc: "2026-10-25 01:02" },
      }),
    ),
    /ISO UTC/,
  );
  assert.match(
    errorsOf(receipt({ head: { ...receipt().head, observationPrep: null } })),
    /observationPrep/,
  );
  assert.throws(
    () => assertCp4Receipt(receipt({ schemaVersion: "x" })),
    /\[precheck\]/,
  );
});

test("批准 7: 正式の Graph の receipt の先頭は K6/4 の凍結。凍結の commit が固定されるまで受け付けない", () => {
  const errors = validateCp4Receipt(receipt(), BOUND());
  assert.equal(errors.length, 1, errors.join(" | "));
  assert.match(errors[0], FREEZE_PENDING);
  assert.throws(() => assertCp4Receipt(receipt(), BOUND()), FREEZE_PENDING);
  assert.equal(K64_FREEZE.freezeCommit, null);
  const { k64, ...noK64 } = receipt().head;
  assert.ok(k64);
  assert.match(errorsOf(receipt({ head: noK64 })), /head\.k64/);
  assert.match(
    errorsOf(
      receipt({
        head: { ...receipt().head, k64: { ...k64, sha256: H64("0") } },
      }),
    ),
    /K6\/4 bytes/,
  );
  // dev の予告は K6/4 の先頭を要しない（書くなら bytes は K6/4 のもの）。
});

test("K6/4-N31: 正式の receipt は批准 5 の (a)〜(c) の記録と、その判定を持つ", () => {
  const { ratification5: _drop, ...noEvidence } = receipt().candidate;
  assert.match(errorsOf(receipt({ candidate: noEvidence })), /ratification5/);
  assert.deepEqual(receipt().aggregates.candidateRegime, {
    regime: "k64",
    missing: [],
  });
  // D-1: a recorded `ancestor: true` that git did not give is self-reported.
  const lacking = receipt({
    candidate: {
      ...receipt().candidate,
      ratification5: ratification5({
        wfWindow: { commit: ratification5().wfWindow.commit, ancestor: false },
      }),
    },
  });
  assert.deepEqual(lacking.aggregates.candidateRegime.missing, [
    "ratification5-not-collected",
  ]);
  assert.match(otherErrors(lacking).join(), /self-reported/);
});

test("D-1: receipt の批准 5 は git から集め直した封印つきの証拠と一致するときだけ K6/4", () => {
  const recorded = JSON.parse(JSON.stringify(ratification5()));
  const value = receipt({
    candidate: {
      ...receipt().candidate,
      commit: ratification5().candidateHead,
      ratification5: recorded,
    },
  });
  // 集め直した証拠を渡さない検証（JSON の receipt だけ）は K6/2 で計算し直す。
  const unbound = otherErrors(value, {});
  assert.ok(unbound.some((error) => /self-reported/.test(error)));
  assert.ok(unbound.some((error) => /aggregates differ/.test(error)));
  // 集め直した証拠と記録が一致すれば K6/4 のまま通る。
  assert.deepEqual(otherErrors(value), []);
  // 記録を書き換えた（祖先でないのに true と書いた）receipt は一致しない。
  const forged = receipt(
    {
      candidate: {
        ...receipt().candidate,
        commit: ratification5().candidateHead,
        ratification5: {
          ...recorded,
          rsJoinHook: { ...recorded.rsJoinHook, receiptSha256: H64("0") },
        },
      },
    },
    { recompute: false },
  );
  forged.aggregates = value.aggregates;
  assert.ok(otherErrors(forged).some((error) => /self-reported/.test(error)));
});

test("K6/4-N17: W_f、T_late、T_show を広げた receipt、手順のファイルの版の無い receipt は受け付けない", () => {
  for (const [key, value] of [
    ["wFMs", 150],
    ["tLateMs", 120],
    ["tShowMs", 2_500],
    ["wFMs", 80],
  ])
    assert.match(
      errorsOf(
        receipt({ settings: { k64: { ...K64_SETTINGS, [key]: value } } }),
      ),
      /N17/,
      `${key}=${value}`,
    );
  assert.match(
    errorsOf(
      receipt({ settings: { k64: { ...K64_SETTINGS, r1r4WaitMs: 10_001 } } }),
    ),
    /10 s/,
  );
  assert.match(
    errorsOf(
      receipt({ settings: { k64: { ...K64_SETTINGS, procedureFile: null } } }),
    ),
    /procedureFile/,
  );
});

test("K6/4-N18: first-render の窓外率を書いていない receipt は集計の再計算と合わない", () => {
  const value = receipt();
  const { outOfWindowRate: _dropped, ...rest } =
    value.aggregates.steadyStateCase;
  value.aggregates = { ...value.aggregates, steadyStateCase: rest };
  assert.match(errorsOf(value), /aggregates differ/);
  assert.equal(receipt().aggregates.steadyStateCase.outOfWindowRate, 1);
  assert.equal(receipt().aggregates.steadyStateCase.k64.displayed, 30);
});

test("P2-6／K6/4-N21: verdict は計算し直して照合し、invalid を持つ receipt は有効にしない", () => {
  for (const outcome of ["PASS", "hold", undefined])
    assert.match(
      errorsOf(receipt({ verdict: { outcome } })),
      /verdict/,
      String(outcome),
    );
  // 欠落が case ごとには 1/30 でも、判定は pool で行い、run の receipt は判定しない。
  const caseWise = receipt({
    samples: k64Rows(variantByKey("G-03/base")).map((row) =>
      row.arm === "graph" && row.phase === "measured" && row.repeat === 0
        ? { ...row, followUp: { ...row.followUp, notices: [], child: null } }
        : row,
    ),
    verdict: { outcome: "HOLD", reason: "case-miss-rate-3.3%" },
  });
  assert.match(errorsOf(caseWise), /verdict/);
  // aggregates.invalid が空でない receipt は、件数が一致しても有効にしない。
  const short = receipt(
    {
      samples: k64Rows(variantByKey("G-03/base")).filter(
        (row) =>
          !(
            row.arm === "graph" &&
            row.phase === "measured" &&
            row.repeat === 29
          ),
      ),
      aggregates: receipt().aggregates,
    },
    { recompute: false },
  );
  assert.match(errorsOf(short), /AB\/BA/);
  const lowLevel = receipt({
    samples: k64Rows(variantByKey("G-03/base")).map((row) =>
      row.arm === "graph" && row.phase === "measured" && row.repeat === 2
        ? {
            ...row,
            followUp: { ...row.followUp, issuedVia: "low-level-continue" },
          }
        : row,
    ),
    verdict: { outcome: "invalid" },
  });
  assert.ok(lowLevel.aggregates.invalid.length > 0);
  assert.match(errorsOf(lowLevel), /invalid run/);
});

test("P3-10: D3 の窓は /proc/locks が読めない標本、slot の file を見ていない標本、終わりが始まりより前の run を gap にする", () => {
  const locks = windowSamples([0, 20_000, 40_000, 62_000]).map((row, at) =>
    at === 2 ? { ...row, locksReadable: false, heavySlotsInUse: null } : row,
  );
  assert.match(
    assessMeasurementWindow({ samples: locks, run: RUN }).gaps.join(),
    /\/proc\/locks/,
  );
  const noSlots = windowSamples([0, 20_000, 40_000, 62_000], {
    heavySlotFiles: 0,
  });
  assert.match(
    assessMeasurementWindow({ samples: noSlots, run: RUN }).gaps.join(),
    /slot file/,
  );
  const reversed = { startedAtMs: 61_000, finishedAtMs: 1_000 };
  assert.match(
    assessMeasurementWindow({
      samples: windowSamples([0, 20_000, 40_000, 62_000]),
      run: reversed,
    }).gaps.join(),
    /finishes before it starts/,
  );
});

test("P1-5: a K2/4 diagnostic negative is a Graph run with the full Graph head", () => {
  const negative = receipt({
    runKind: "g-case-diagnostic-negative",
    samples: [sample({ variantKey: "G-02/base" })],
    settings: { variantKey: "G-02/base" },
  });
  assert.deepEqual(otherErrors(negative), []);
  assert.match(
    errorsOf({
      ...negative,
      head: { ...negative.head, observationPrep: null },
    }),
    /observationPrep/,
  );
  assert.match(
    errorsOf({
      ...negative,
      candidate: { ...negative.candidate, evalReceiptSha256: null },
    }),
    /evalReceiptSha256/,
  );
  assert.match(
    errorsOf({
      ...negative,
      candidate: { ...negative.candidate, workerSha256: null },
    }),
    /workerSha256/,
  );
  assert.match(
    errorsOf({
      ...negative,
      settings: {
        ...negative.settings,
        d2aModes: { hybrid: "restricted", graph: "unrestricted" },
      },
    }),
    /restricted \(D10\)/,
  );
});

test("P1-5: Graph-free run kinds refuse R+IR+Graph samples; the 24 allow only not-requested", () => {
  const graphRow = sample({ variantKey: "G-02/base" });
  for (const runKind of ["g-case-parity-unrestricted", "g01-pair"])
    assert.match(
      errorsOf(
        receipt({
          runKind,
          samples: [graphRow],
          settings: { variantKey: "G-02/base" },
        }),
      ),
      /does not run the R\+IR\+Graph arm/,
      runKind,
    );
  const existing = (graph) =>
    receipt({
      runKind: "existing-24-compare",
      fixture: null,
      samples: [{ arm: "graph", trigger: "user-operation", graph }],
      requeries: [],
    });
  assert.deepEqual(
    validateCp4Receipt(existing({ status: "not-requested", seed: null })),
    [],
  );
  assert.match(
    errorsOf(existing({ status: "graph-ready", seed: null })),
    /only ever not-requested/,
  );
  assert.match(
    errorsOf(existing({ status: "not-requested", seed: "e1" })),
    /only ever not-requested/,
  );
});

test("P2-7: the receipt's own claims are recomputed, never trusted", () => {
  assert.match(
    errorsOf(
      receipt({
        environment: {
          ...receipt().environment,
          netLog: { sha256: H64("7"), nonLoopbackAttempts: 1 },
        },
      }),
    ),
    /N-12/,
  );
  const heavy = windowSamples([0, 20_000, 40_000, 62_000]).map((row, at) =>
    at === 1 ? { ...row, heavySlotsInUse: 1 } : row,
  );
  assert.match(
    errorsOf(
      receipt({
        environment: { ...receipt().environment, windowSamples: heavy },
      }),
    ),
    /windowAssessment differs/,
  );
  const tampered = receipt();
  tampered.aggregates = {
    ...tampered.aggregates,
    steadyStateCase: {
      ...tampered.aggregates.steadyStateCase,
      inWindow: 29,
      outOfWindow: 1,
    },
  };
  assert.match(errorsOf(tampered), /aggregates differ/);
  const lateRows = scheduleRows(
    [variantByKey("G-03/base")],
    (variant, repeat) =>
      repeat < 3
        ? { graph: { joined: false, arrivedAt: null, revalidation: null } }
        : {},
  );
  const claimed = receipt({ samples: lateRows }, { recompute: false });
  claimed.aggregates = receipt().aggregates;
  assert.match(errorsOf(claimed), /aggregates differ/);
  const unscheduled = receipt(
    { samples: lateRows.slice(1) },
    { recompute: false },
  );
  unscheduled.aggregates = receipt().aggregates;
  assert.match(errorsOf(unscheduled), /AB\/BA/);
});

test("P2-7: a declaration run is checked against the measurement workspace and the seam", () => {
  const declared = (value, workspace = WORKSPACE) =>
    receipt({
      settings: { variantKey: "G-02/base" },
      declaration: value,
      measurementWorkspace: workspace,
    });
  assert.match(errorsOf(declared(undefined)), /declaration\.workspaceId/);
  assert.deepEqual(otherErrors(declared(declaration())), []);
  assert.match(
    errorsOf(declared(declaration({ verified: false }))),
    /verified/,
  );
  assert.match(
    errorsOf(declared(declaration({ indexAfter: indexMeta(4) }))),
    /generation changed/,
  );
  assert.match(
    errorsOf(
      declared(
        declaration({
          seamReceipt: {
            ...declaration().seamReceipt,
            bindingDigest: H64("0"),
          },
        }),
      ),
    ),
    /seam receipt binds another declaration/,
  );
  assert.match(
    errorsOf(declared(declaration(), { ...WORKSPACE, workspaceId: "ws-2" })),
    /not current/,
  );
});

test("P2-12: the fixture block binds the variant, path, digest and kind", () => {
  assert.match(
    errorsOf(receipt({ fixture: { ...receipt().fixture, sha256: H64("0") } })),
    /frozen digest do not match/,
  );
  assert.match(
    errorsOf(receipt({ fixture: { ...receipt().fixture, kind: "dev" } })),
    /fixture\.kind must be frozen/,
  );
  assert.match(
    errorsOf(receipt({ fixture: null })),
    /clean repo-relative path/,
  );
  assert.match(
    errorsOf(
      receipt({
        fixture: {
          path: "evals/nir1-graph/g02-directed-relation.v1.json",
          sha256:
            FROZEN_FIXTURE_SHA256[
              "evals/nir1-graph/g02-directed-relation.v1.json"
            ],
          kind: "frozen",
        },
      }),
    ),
    /do not match/,
  );
  // A dev preview carries its own dev variant and needs no observation-prep head.
  const devKey = "dev:dev-g02.v1/base";
  const devVariantRow = { key: devKey, expectedGraph: "available" };
  const devRun = {
    ...receipt(),
    preview: true,
    fixture: {
      path: "scripts/quality/nir1-graph-eval/dev-fixtures/dev-g02.v1.json",
      sha256: H64("d"),
      kind: "dev",
    },
    head: { ...receipt().head, observationPrep: null },
    // A dev preview stays a K6/2-era preview (no 批准 5 evidence).
    candidate: { ...receipt().candidate, ratification5: undefined },
    settings: {
      ...receipt().settings,
      variantKey: devKey,
      devVariant: devVariantRow,
    },
    samples: scheduleRows([devVariantRow]),
    requeries: [],
    verdict: { outcome: "preview-only" },
  };
  delete devRun.candidate.ratification5;
  devRun.aggregates = computeRunAggregates(devRun, {
    ...devVariantRow,
    kind: "dev",
    declaration: false,
  });
  assert.deepEqual(validateCp4Receipt(devRun), []);
  assert.match(errorsOf({ ...devRun, preview: false }), /always a preview/);
  assert.match(
    errorsOf({
      ...devRun,
      fixture: {
        ...devRun.fixture,
        sha256:
          FROZEN_FIXTURE_SHA256[
            "evals/nir1-graph/g02-directed-relation.v1.json"
          ],
      },
    }),
    /copy of frozen material/,
  );
  assert.match(
    errorsOf({
      ...devRun,
      settings: {
        ...devRun.settings,
        devVariant: { key: "G-02/base", expectedGraph: "available" },
      },
    }),
    /dev variant key/,
  );
});

test("P-3 / N-5 / N-6: only a current declaration with unchanged Index metadata proceeds", () => {
  assert.deepEqual(
    assertDeclarationCurrent({
      declaration: declaration(),
      measurementWorkspace: WORKSPACE,
    }),
    { proceed: true },
  );
  for (const field of [
    "workspaceId",
    "canonicalLocatorDigest",
    "bindingDigest",
  ])
    assert.throws(
      () =>
        assertDeclarationCurrent({
          declaration: declaration(),
          measurementWorkspace: { ...WORKSPACE, [field]: "other" },
        }),
      (error) =>
        /\[precheck\].*not current/.test(error.message) &&
        !/blocked/.test(error.message),
      field,
    );
  assert.throws(
    () =>
      assertDeclarationCurrent({
        declaration: declaration({ indexAfter: indexMeta(4) }),
        measurementWorkspace: WORKSPACE,
      }),
    /\[precheck\] b Index generation changed/,
  );
  assert.throws(
    () =>
      assertDeclarationCurrent({
        declaration: declaration({ indexAfter: indexMeta(3, true) }),
        measurementWorkspace: WORKSPACE,
      }),
    /\[precheck\] b Index dirty changed/,
  );
  assert.throws(
    () =>
      assertDeclarationCurrent({
        declaration: declaration({ indexBefore: null }),
        measurementWorkspace: WORKSPACE,
      }),
    /\[precheck\] declaration record incomplete/,
  );
});

test("D3 / N-14 / P2-8: window violations, gaps and missing fields exclude a run but keep it", () => {
  const clean = assessMeasurementWindow({
    samples: windowSamples([0, 20_000, 40_000, 62_000]),
    run: RUN,
  });
  assert.deepEqual(clean, { clean: true, violations: [], gaps: [] });
  const heavy = assessMeasurementWindow({
    samples: windowSamples([0, 20_000, 40_000, 62_000]).map((row, at) =>
      at === 2 ? { ...row, heavySlotsInUse: 1 } : row,
    ),
    run: RUN,
  });
  assert.equal(heavy.clean, false);
  assert.match(heavy.violations.join(), /heavy slot/);
  assert.equal(
    assessMeasurementWindow({
      samples: windowSamples([0, 20_000, 40_000, 62_000], {
        buildProcesses: [{ pid: 42, command: "vite build" }],
      }),
      run: RUN,
      ownPids: [42],
    }).clean,
    true,
  );
  assert.match(
    assessMeasurementWindow({
      samples: windowSamples([0, 20_000, 62_000]),
      run: RUN,
    }).gaps.join(),
    /too far apart/,
  );
  assert.match(
    assessMeasurementWindow({
      samples: windowSamples([2_000, 20_000, 40_000, 62_000]),
      run: RUN,
    }).gaps.join(),
    /before the run/,
  );
  for (const field of [
    "heavySlotsInUse",
    "buildProcesses",
    "otherMeasurements",
    "sameWorktreeBuild",
    "atMs",
  ]) {
    const rows = windowSamples([0, 20_000, 40_000, 62_000]);
    delete rows[1][field];
    const result = assessMeasurementWindow({ samples: rows, run: RUN });
    assert.equal(result.clean, false, field);
    assert.match(result.gaps.join(), new RegExp(field));
  }
  assert.equal(
    assessMeasurementWindow({ samples: windowSamples([0, 62_000]), run: {} })
      .clean,
    false,
  );
  const kept = selectReceiptsForAggregation([
    {
      runId: "ok",
      run: RUN,
      environment: {
        windowSamples: windowSamples([0, 20_000, 40_000, 62_000]),
      },
    },
    {
      runId: "heavy",
      run: RUN,
      environment: {
        windowSamples: windowSamples([0, 20_000, 40_000, 62_000], {
          heavySlotsInUse: 1,
        }),
        windowAssessment: { clean: true },
      },
    },
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

test("N-11 / P2-9: Electron draws only on the run's Xvfb, without Wayland, D-Bus, ozone override or a netns", () => {
  const env = {
    DISPLAY: ":99",
    XDG_SESSION_TYPE: "x11",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    XDG_RUNTIME_DIR: "/r/.artifacts/cp4/run/tmp/xdg-runtime",
    NO_AT_BRIDGE: "1",
  };
  const netns = {
    self: "net:[4026531840]",
    parent: "net:[4026531840]",
    hostInterfaces: ["lo", "enp5s0"],
    userManager: "net:[4026531840]",
  };
  // B-3: libdbus／GDBus fall back to $XDG_RUNTIME_DIR/bus without an address.
  for (const runtime of [undefined, "/run/user/1000", "/run/user/1000/x"])
    assert.throws(
      () =>
        assertElectronLaunch({
          env: { ...env, XDG_RUNTIME_DIR: runtime },
          argv: [],
          xvfbDisplay: ":99",
          netns,
        }),
      /XDG_RUNTIME_DIR/,
    );
  assert.throws(
    () =>
      assertElectronLaunch({
        env: { ...env, NO_AT_BRIDGE: undefined },
        argv: [],
        xvfbDisplay: ":99",
        netns,
      }),
    /NO_AT_BRIDGE/,
  );
  const launch = (overrides = {}) =>
    assertElectronLaunch({
      env,
      argv: ["node", "electron"],
      xvfbDisplay: ":99",
      netns,
      ...overrides,
    });
  assert.deepEqual(launch().removedEnv, [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "DBUS_SESSION_BUS_ADDRESS",
  ]);
  for (const name of [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    assert.throws(
      () => launch({ env: { ...env, [name]: "x" } }),
      /\[precheck\]/,
    );
  assert.throws(
    () => launch({ env: { ...env, XDG_SESSION_TYPE: "wayland" } }),
    /Wayland/,
  );
  assert.throws(
    () => launch({ env: { ...env, ELECTRON_OZONE_PLATFORM_HINT: undefined } }),
    /ozone/,
  );
  assert.throws(() => launch({ env: { ...env, DISPLAY: ":0" } }), /never :0/);
  assert.throws(
    () => launch({ env: { ...env, DISPLAY: ":0" }, xvfbDisplay: ":0" }),
    /never :0/,
  );
  assert.throws(() => launch({ xvfbDisplay: undefined }), /display number/);
  for (const argv of [
    ["electron", "--ozone-platform=wayland"],
    ["electron", "--ozone-platform", "wayland"],
    ["electron", "--enable-features=UseOzonePlatform"],
  ])
    assert.throws(() => launch({ argv }), /ozone platform/, argv.join(" "));
  assert.doesNotThrow(() =>
    launch({ argv: ["electron", "--ozone-platform=x11"] }),
  );
  for (const argv of [
    ["/usr/bin/unshare", "-rn", "Xvfb"],
    ["ip", "netns", "exec", "x"],
    ["bwrap", "--unshare-net", "electron"],
    ["firejail", "electron"],
  ])
    assert.throws(() => launch({ argv }), /network namespace/, argv.join(" "));
  assert.throws(
    () => launch({ netns: { ...netns, self: "net:[1]", parent: "net:[2]" } }),
    /parent's network namespace/,
  );
  // B-4: `unshare -rn node wrapper …` puts the harness and its parent in the
  // same private namespace; only lo is there, and it differs from the user's
  // systemd manager's.
  assert.throws(
    () =>
      launch({
        netns: {
          self: "net:[9]",
          parent: "net:[9]",
          hostInterfaces: ["lo"],
          userManager: null,
        },
      }),
    /host network namespace/,
  );
  assert.throws(
    () =>
      launch({
        netns: { ...netns, self: "net:[9]", parent: "net:[9]" },
      }),
    /host network namespace/,
  );
  assert.throws(
    () => launch({ netns: { self: "net:[9]", parent: "net:[9]" } }),
    /host network namespace/,
  );
  // systemd --user が見つからない環境は interface の基準だけで通す（開示する）。
  assert.doesNotThrow(() => launch({ netns: { ...netns, userManager: null } }));
  assert.throws(
    () => launch({ netns: undefined }),
    /parent's network namespace/,
  );
  assert.doesNotThrow(() =>
    launch({ netns: { unavailable: true, reason: "no /proc on darwin" } }),
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

test("DR-CP4-S1C1-9: the receipt's feature set is exactly the evaluation feature", () => {
  const withFeatures = (features) =>
    receipt({ candidate: { ...receipt().candidate, features } });
  assert.deepEqual(otherErrors(withFeatures(["nir1-graph-eval"])), []);
  for (const features of [
    ["nir1-graph-eval", "licensing"],
    ["licensing", "nir1-graph-eval"],
    [],
    "nir1-graph-eval",
  ])
    assert.match(errorsOf(withFeatures(features)), /exactly the evaluation/);
});

test("DR-CP4-S1C1-6: socket samples cover the run and an external socket is [precheck]", () => {
  const withSockets = (samples) =>
    receipt({
      environment: { ...receipt().environment, socketSamples: samples },
    });
  assert.match(errorsOf(withSockets([])), /socketSamples: fewer than two/);
  assert.match(
    errorsOf(withSockets(socketSamples([20_000, 40_000, 62_000]))),
    /before the run/,
  );
  const external = socketSamples([0, 20_000, 40_000, 62_000]).map((row, at) =>
    at === 1
      ? {
          ...row,
          external: [
            {
              pid: 11,
              proto: "tcp",
              local: "10.0.0.2:5000",
              remote: "140.82.112.3:443",
            },
          ],
        }
      : row,
  );
  assert.match(
    errorsOf(withSockets(external)),
    /\[precheck\].*external socket/,
  );
});

test("B-2: 停止の後の副作用の証拠（残った process、close、X11、辞書、外部の server、切れた net log、observer、worker）は合否に入る", () => {
  const env = receipt().environment;
  for (const [label, change, pattern] of [
    ["remaining", { stop: { ...env.stop, remaining: [77] } }, /remaining/],
    ["no-stop", { stop: null }, /environment\.stop/],
    ["not-closed", { stop: { ...env.stop, closed: false } }, /closed/],
    ["x11", { x11: { before: [], after: [{ name: "X5", ino: 2 }] } }, /X11/],
    [
      "bdic",
      {
        profileEgress: {
          ...env.profileEgress,
          dictionaries: ["en-US-10-1.bdic"],
        },
      },
      /dictionar/,
    ],
    [
      "persisted",
      {
        profileEgress: {
          ...env.profileEgress,
          networkPersistentServers: ["https://example.com"],
        },
      },
      /persisted/,
    ],
    ["truncated", { netLog: { ...env.netLog, truncated: true } }, /truncated/],
    ["observer", { observer: { ok: false, problems: ["x"] } }, /observer/],
    ["worker", { mainWorker: { ...env.mainWorker, ok: false } }, /A-3|worker/],
    [
      "worker-other-build",
      {
        mainWorker: { ...env.mainWorker, atStart: H64("9"), atEnd: H64("9") },
      },
      /worker/,
    ],
  ]) {
    const errors = otherErrors(
      receipt({ environment: { ...env, ...change } }),
    ).join(" | ");
    assert.match(errors, pattern, label);
  }
});
