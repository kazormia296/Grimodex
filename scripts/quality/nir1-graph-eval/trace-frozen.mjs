// CP-4 S5-B: 凍結した trace の配線（DR-CP4-O-1 (6)、DR-CP4-TR-8 の S6 の手順）。
//
// `trace-runner.mjs` の凍結の分岐が、Electron を起動する前に通る部分:
//   1. K6/4 の凍結の head（安い検査を先に）。
//   2. G-02 base の setup の受領書: 完全な setup（`assertCompleteSetupReceipt`）か、
//      上限内の開き直しで setup-complete に届かなかった記録（S2 `setupFailure`:
//      (b) は未測定、CP-4 の可用性は HOLD、project は差し替えない）。
//   3. `admitGraphCaseRun`（凍結の path と sha256、観測前の commit、build の
//      受領書、既定の addon、批准 5、K6/2 と K6/4 の head）。
//   4. 観測前の記録の `traces`（S4 が commit と SHA-256 を埋める）を commit から
//      読み直し、receipt の先頭（head.json）を測定の前に書く。
//   5. trace の file（`loadTracePlan({ commit })`）、論理→runtime（setup の
//      受領書の `typedRevisions` を含む）、試行の履歴、手順の file（正式の版）。
// 測定の後の開示: 開始時の封印の読取（S2 `startSeal.receipt`）、Q の外の
// query の理由ごとの数（`frozen-diagnostics.mjs`）。閾値、分類器、S2 の file は
// 変えない。

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  admitGraphCaseRun,
  collectObservationPrepFacts,
  readK64FreezeHead,
} from "./admission.mjs";
import {
  buildRunHead,
  claimFrozenAttempt,
  frozenAttemptLedger,
  readBoundFile,
  readSpP4Gate,
  readTraceFileHeads,
  traceAttemptKey,
  writeRunHead,
} from "./frozen-diagnostics.mjs";
import { loadProcedureFile } from "./procedure-file.mjs";
import { verifySeedPins } from "./seed-pin.mjs";
import {
  FROZEN_SETUP_RECEIPT_SCHEMA,
  MAINTENANCE_OPENINGS_MAX,
  SEAL_OPENINGS_MAX,
  assertCompleteSetupReceipt,
  loadSetupReceipt,
} from "./setup-receipt.mjs";
import {
  TRACE_KINDS,
  TRACE_RUN_SCHEMA,
  loadTracePlan,
  tracePlanIdentity,
} from "./trace-record.mjs";

/** S2 `project`: the trace's fixed project (the version does not swap it). */
export const TRACE_PROJECT = Object.freeze({
  caseId: "G-02",
  variantId: "base",
  fixturePath: "evals/nir1-graph/g02-directed-relation.v1.json",
});
/** S2 `setupFailure.decision`. */
export const TRACE_SETUP_FAILURE_DECISION = "S3v6 の P2-3 と P-S2-2";

function fail(code, detail) {
  throw new Error(`[precheck] S5-B trace ${code}: ${detail}`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function openingsBySession(rows) {
  const counts = {};
  for (const row of rows ?? []) {
    const session = row?.session ?? "author";
    counts[session] = (counts[session] ?? 0) + 1;
  }
  return counts;
}

/**
 * The G-02 base setup receipt of a trace: `complete` (sealed and checked as
 * a complete setup) or `setup-failure` (stopped `blocked` with the harness's
 * name, within the reopen limits). Anything else is `[precheck]`: another
 * case or variant, the R5 check run's receipt, an SP-P4 branch, a dev setup,
 * a failure without a blocked name (a harness problem to look at first).
 */
export function readTraceSetup({ root, file }) {
  const absolute = path.resolve(root, file);
  let bytes;
  let raw;
  try {
    bytes = readFileSync(absolute);
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("setup", `${file} cannot be read`);
  }
  if (raw?.schemaVersion !== FROZEN_SETUP_RECEIPT_SCHEMA)
    fail("setup", `${file} is not a frozen G-case setup receipt`);
  if (
    raw?.fixture?.kind !== "frozen" ||
    raw?.fixture?.caseId !== TRACE_PROJECT.caseId ||
    raw?.fixture?.variantId !== TRACE_PROJECT.variantId ||
    raw?.fixture?.path !== TRACE_PROJECT.fixturePath
  )
    fail(
      "setup",
      `${file} is not the G-02 base setup (S2 project; the version does not swap the project)`,
    );
  // Review P2-2: an SP-P4 branch or an R5 check setup is never the trace's.
  if (raw?.seedPinBranch !== undefined || raw?.r5CheckRun !== undefined)
    fail(
      "setup",
      `${file} is an SP-P4 branch or an R5 check setup, not the trace's G-02 base setup`,
    );
  if (raw?.stopsAt !== "complete")
    fail(
      "setup",
      `${file} stopped at ${String(raw?.stopsAt)}; a trace needs the complete setup`,
    );
  if (raw.status === "setup-complete") {
    const setup = assertCompleteSetupReceipt(
      loadSetupReceipt({ root, file: absolute }),
    );
    return { kind: "complete", setup, raw, sha256: setup.sha256 };
  }
  if (raw.status === "blocked" && typeof raw.blocked?.harnessId === "string") {
    const seal = openingsBySession(raw.sealAttempts);
    const maintenance = (raw.maintenanceAttempts ?? []).length;
    if (
      Object.values(seal).some((count) => count > SEAL_OPENINGS_MAX) ||
      maintenance > MAINTENANCE_OPENINGS_MAX
    )
      throw new Error(
        `[artifact] S5-B trace: ${file} records more openings than the reopen limits`,
      );
    return {
      kind: "setup-failure",
      raw,
      sha256: sha256(bytes),
      setupFailure: Object.freeze({
        decision: TRACE_SETUP_FAILURE_DECISION,
        project: `${TRACE_PROJECT.caseId}/${TRACE_PROJECT.variantId}`,
        b: "unmeasured",
        cp4Availability: "HOLD",
        projectSwapAllowed: false,
        setupReceipt: {
          path: path.relative(root, absolute),
          sha256: sha256(bytes),
        },
        // The harness's name as recorded (setupReadings.blockedCaseJudgement).
        blocked: { ...raw.blocked },
        openings: {
          seal: seal.seal ?? 0,
          bySession: seal,
          maintenance,
          limits: {
            seal: SEAL_OPENINGS_MAX,
            maintenance: MAINTENANCE_OPENINGS_MAX,
          },
        },
      }),
    };
  }
  fail(
    "setup",
    `${file} ended ${String(raw.status)} without a blocked name; it is not S2's setup failure (look at the setup before retaking)`,
  );
}

/**
 * The trace's logical IDs through the setup receipt (DR-CP4-TR-8 (1)): the
 * runtime ids the launch helpers take, the seed, the expected materials'
 * typed Revisions. A missing ID or another fixture is `[precheck]`.
 */
export function frozenTraceRuntime({ plan, setupRaw }) {
  if (
    plan?.project?.caseId !== TRACE_PROJECT.caseId ||
    plan?.project?.variantId !== TRACE_PROJECT.variantId ||
    plan?.project?.fixtureSha256 !== setupRaw?.fixture?.sha256
  )
    fail("runtime", "the trace file's project is not this setup's G-02 base");
  const map = setupRaw.logicalToRuntime ?? {};
  const scene = (logical) => {
    const runtime = map.scenes?.[logical];
    if (typeof runtime !== "string")
      fail("runtime", `the setup maps no runtime Scene to ${logical}`);
    return runtime;
  };
  const sceneIds = new Set([plan.querySceneId]);
  if (plan.browse?.otherSceneId) sceneIds.add(plan.browse.otherSceneId);
  for (const row of plan.operations ?? []) {
    if (row.sceneId) sceneIds.add(row.sceneId);
    if (row.query?.querySceneId) sceneIds.add(row.query.querySceneId);
  }
  for (const logical of sceneIds) scene(logical);
  const seed = map.entities?.[plan.seed?.entityId];
  if (typeof seed !== "string")
    fail(
      "runtime",
      `the setup maps no runtime Entity to ${plan.seed?.entityId}`,
    );
  const revisions = {};
  for (const row of plan.expectedMaterials ?? []) {
    const runtime = map.typedRevisions?.[row.revisionId]?.revisionId;
    if (typeof runtime !== "string")
      fail(
        "runtime",
        `the setup maps no typed Revision to ${row.revisionId} (F6 needs the material's Revision)`,
      );
    revisions[row.revisionId] = runtime;
  }
  return Object.freeze({
    ids: {
      projectId: map.projectId,
      querySceneId: scene(plan.querySceneId),
      scenes: { ...map.scenes },
      entities: { ...map.entities },
      typedRevisions: { ...map.typedRevisions },
    },
    seed,
    materials: plan.expectedMaterials.map((row) => revisions[row.revisionId]),
    revisions,
  });
}

/**
 * S2 `stall.attemptRule`: attempt n is taken only after attempts 1..n-1 of
 * the same trace file (path, commit, SHA-256) stalled and were retaken; the
 * history is disclosed. A completed or a `[precheck]` earlier attempt, a gap
 * in the numbering, or another file is `[precheck]`.
 */
export function traceAttemptHistory({
  attempt,
  attemptLimit,
  previous,
  identity,
}) {
  if (!Number.isInteger(attemptLimit) || attemptLimit < 1)
    fail("attempt", "the trace file's stall.attemptLimit is invalid");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > attemptLimit)
    fail(
      "attempt",
      `--attempt must be an integer from 1 to ${attemptLimit} (S2 stall.attemptLimit)`,
    );
  const rows = [...(previous ?? [])].sort(
    (left, right) =>
      (left.receipt?.attempt ?? 0) - (right.receipt?.attempt ?? 0),
  );
  if (rows.length !== attempt - 1)
    fail(
      "attempt",
      `attempt ${attempt} needs the receipts of the ${attempt - 1} earlier attempts (${rows.length} given)`,
    );
  return rows.map((row, at) => {
    const receipt = row.receipt ?? {};
    if (receipt.attempt !== at + 1)
      fail(
        "attempt",
        `the earlier receipts are not attempts 1..${attempt - 1}`,
      );
    if (
      receipt.trace?.path !== identity.path ||
      receipt.trace?.sha256 !== identity.sha256 ||
      receipt.trace?.commit !== identity.commit
    )
      fail("attempt", `attempt ${at + 1} ran another trace file`);
    if (receipt.attemptOutcome !== "retake" || !receipt.stalled)
      fail(
        "attempt",
        `attempt ${at + 1} ended ${String(receipt.attemptOutcome)}; only a stalled attempt is retaken`,
      );
    return {
      attempt: receipt.attempt,
      runId: receipt.runId ?? null,
      receiptSha256: row.sha256,
      stalled: receipt.stalled,
      attemptOutcome: receipt.attemptOutcome,
    };
  });
}

/** Round trips of the renderer clock through CDP (`driver.now()`), in ms. */
export async function measureCdpNow(
  now,
  { count = 20, clock = () => performance.now() } = {},
) {
  const samples = [];
  for (let at = 0; at < count; at++) {
    const started = clock();
    await now();
    samples.push(clock() - started);
  }
  return samples;
}

/**
 * S2 `runnerReadings.startSeal.receipt`: each seal-read's start and end
 * (renderer time through CDP), the reads per counted query, and the CDP
 * `now()` round trip disclosed (the delay is not subtracted).
 */
export function startSealReceipt({ log, cdpNowMs }) {
  const reads = (log ?? [])
    .filter((row) => row?.op === "seal-read")
    .map((row) => ({
      index: row.index,
      phase: row.phase,
      startedAt: row.at,
      finishedAt: row.finishedAt,
      durationMs: row.finishedAt - row.at,
    }));
  const countByQuery = {};
  for (const row of reads)
    countByQuery[row.index] = (countByQuery[row.index] ?? 0) + 1;
  const sorted = [...(cdpNowMs ?? [])].sort((left, right) => left - right);
  return {
    total: reads.length,
    countByQuery,
    reads,
    cdpNow: {
      clock: "renderer performance.now() through CDP (driver.now())",
      samples: sorted.length,
      roundTripMs:
        sorted.length === 0
          ? null
          : {
              min: sorted[0],
              median: sorted[Math.floor((sorted.length - 1) / 2)],
              max: sorted.at(-1),
            },
    },
  };
}

/**
 * R5 on the trace's own workspace (S2 `seed.source`): SP-P1's one-row check
 * — exactly one pin on the query Scene, the product's first pin the planned
 * seed — on the measurement copy. (`assertSeedPinsBeforeK64` with the frozen
 * plan needs all 13 variants; a trace has one workspace.)
 */
export function traceSeedPinCheck({ plan, setupRaw, read }) {
  const map = setupRaw.logicalToRuntime;
  const [row] = verifySeedPins([
    {
      caseId: TRACE_PROJECT.caseId,
      variantId: TRACE_PROJECT.variantId,
      querySceneId: map.scenes[plan.querySceneId],
      expectedSeed: map.entities[plan.seed.entityId],
      expectedSeedLogical: plan.seed.entityId,
      entityRuntimeIds: map.entities,
      read,
    },
  ]).rows;
  if (row.status !== "match")
    throw new Error(
      `[precheck] R5: the trace workspace's query Scene pin is ${row.status}; the trace does not run (observation-prep r5Gate)`,
    );
  return row;
}

/**
 * Everything a frozen trace needs before its first launch (DR-CP4-O-1 (6)).
 * `inputs` are the build receipts and the default addon's SHA-256 the CLI
 * read; `deps` replace the git readers (tests). Returns the setup failure
 * (no launch) or the admission, head, plan, runtime, attempts and procedure.
 */
export async function prepareFrozenTrace({
  root,
  runDir,
  options,
  inputs,
  deps = {},
}) {
  const {
    readK64Head = readK64FreezeHead,
    admit = admitGraphCaseRun,
    collectFacts = collectObservationPrepFacts,
    readTraceHeads = readTraceFileHeads,
    loadPlan = loadTracePlan,
    loadProcedure = loadProcedureFile,
    readPrevious = readPreviousAttempts,
    readDeclaration = readTraceDeclaration,
    readSpP4 = readSpP4Gate,
    readTree = (commit) =>
      execFileSync("git", ["rev-parse", `${commit}^{tree}`], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    claimAttempt = (input, ledger) => claimFrozenAttempt({ ...input, ledger }),
    now = () => new Date(),
  } = deps;
  // The K6/4 freeze head first (cheap), before any other read.
  readK64Head({ root, commit: options["k64-commit"] });
  const kind = options["trace-kind"];
  if (!TRACE_KINDS.includes(kind))
    fail("kind", "--trace-kind is editing or browsing");
  const state = readTraceSetup({ root, file: options.setup });
  const admission = admit({
    root,
    candidateHead: "HEAD",
    prepCommit: options["prep-commit"],
    buildReceipt: inputs.buildReceipt,
    productReceipt: inputs.productReceipt,
    fixtures: [
      { path: state.raw.fixture.path, sha256: state.raw.fixture.sha256 },
    ],
    defaultAddonSha256: inputs.defaultAddonSha256,
    k62Commit: options["k62-commit"],
    k64Commit: options["k64-commit"],
    ...(inputs.ratification5 !== undefined
      ? { ratification5: inputs.ratification5 }
      : {}),
  });
  // Review P2-2: the setup (complete or failed) ran on this candidate.
  if (
    state.raw.candidate?.commit !== admission.candidateHead ||
    state.raw.candidate?.tree !== readTree(admission.candidateHead)
  )
    fail(
      "setup",
      "the G-02 base setup ran on another candidate (commit or tree)",
    );
  const record = collectFacts({
    root,
    commit: options["prep-commit"],
    candidateHead: "HEAD",
  }).record;
  const traces = readTraceHeads({ root, traces: record?.traces });
  // K6/2 事前登録の凍結 2: the head is written before any measurement.
  const head = buildRunHead(
    {
      kind: "trace",
      k62: admission.head.k62,
      k64: admission.head.k64,
      observationPrep: admission.head.observationPrep,
      traces,
    },
    { now },
  );
  // Review P3 (e) / P2-c: one ledger claim per frozen trace attempt, keyed
  // by the trace file's identity and the candidate (never the run name).
  const claimed = claimAttempt(
    {
      kind: "trace",
      key: traceAttemptKey({
        trace: traces.find((row) => row.kind === kind),
        candidateCommit: admission.candidateHead,
      }),
    },
    frozenAttemptLedger({
      root,
      candidate: {
        commit: admission.candidateHead,
        tree: readTree(admission.candidateHead),
      },
      s4Commit: admission.head.observationPrep.commit,
      runName: options.run,
      startedAtUtc: now().toISOString(),
      attempt: Number(options.attempt ?? "1"),
    }),
  );
  const written = await writeRunHead({ runDir, head });
  const base = {
    admission,
    ledger: claimed ?? null,
    head,
    headSha256: written.sha256,
    kind,
    setup: state,
  };
  if (state.kind === "setup-failure")
    return { ...base, setupFailure: state.setupFailure };
  // S2 r5Gate.beforeFirstGatedRun: no trace before ④'s SP-P4 passed.
  if (!options["sp-p4-receipt"])
    fail("sp-p4", "a frozen trace needs ④'s SP-P4 receipt (--sp-p4-receipt)");
  const spP4 = readSpP4({
    file: path.resolve(options["sp-p4-receipt"]),
    head: admission.head,
    candidateCommit: admission.candidateHead,
  });
  const entry = traces.find((row) => row.kind === kind);
  const loaded = loadPlan({ root, file: entry.path, commit: entry.commit });
  if (loaded.sha256 !== entry.sha256 || loaded.commit !== entry.commit)
    fail(
      "plan",
      `${entry.path} read from ${entry.commit} is not S2's ${entry.sha256}`,
    );
  const identity = tracePlanIdentity(loaded);
  const runtime = frozenTraceRuntime({
    plan: loaded.plan,
    setupRaw: state.raw,
  });
  const declaration = readDeclaration({ root, record });
  if (typeof runtime.ids.scenes[declaration.sceneId] !== "string")
    fail(
      "declaration",
      `the setup maps no runtime Scene to the declared ${declaration.sceneId}`,
    );
  const attempts = traceAttemptHistory({
    attempt: Number(options.attempt ?? "1"),
    attemptLimit: loaded.plan.stall?.attemptLimit,
    previous: readPrevious(options["previous-attempts"]),
    identity,
  });
  const procedure = loadProcedure({
    root,
    version: options["procedure-version"] ?? "v1",
    commit: options["procedure-commit"] ?? options["prep-commit"],
    purpose: "formal",
  });
  return {
    ...base,
    setupFailure: null,
    plan: loaded.plan,
    identity,
    runtime,
    attempts,
    procedure,
    declaration,
    spP4,
  };
}

/** S2's K2/4 declaration addendum for the graph cases (a bound file). */
export const DECLARATION_ADDENDUM_PATH =
  "evals/nir1-graph/declaration-addendum.v1.json";

/**
 * The trace project's declared Scene (S2 `project.setup`: the K2/4
 * declaration step, declarationPlace (ii)), read from the bound addendum at
 * its commit. `[precheck]` when the addendum or the G-02 base row is missing.
 */
export function readTraceDeclaration({ root, record, read = readBoundFile }) {
  const bound = read({ root, record, file: DECLARATION_ADDENDUM_PATH });
  let value;
  try {
    value = JSON.parse(Buffer.from(bound.bytes).toString("utf8"));
  } catch {
    fail("declaration", `${DECLARATION_ADDENDUM_PATH} is not JSON`);
  }
  const rows = (value?.declarations ?? []).filter(
    (row) =>
      row?.caseId === TRACE_PROJECT.caseId &&
      row?.variantId === TRACE_PROJECT.variantId,
  );
  if (rows.length !== 1 || typeof rows[0].sceneId !== "string")
    fail("declaration", "the addendum has no single G-02 base declaration");
  return {
    sceneId: rows[0].sceneId,
    addendum: { path: bound.path, commit: bound.commit, sha256: bound.sha256 },
  };
}

/** `--previous-attempts a.json,b.json`: the earlier attempts' receipts. */
export function readPreviousAttempts(list) {
  if (!list) return [];
  return String(list)
    .split(",")
    .filter(Boolean)
    .map((file) => {
      let bytes;
      try {
        bytes = readFileSync(path.resolve(file));
      } catch {
        fail("attempt", `${file} cannot be read`);
      }
      return {
        sha256: sha256(bytes),
        receipt: JSON.parse(bytes.toString("utf8")),
      };
    });
}

/**
 * The receipt of a trace whose G-02 base setup never reached setup-complete
 * (S2 `setupFailure`): (b) is unmeasured, CP-4's availability is HOLD, the
 * project is not swapped; no Electron was launched for the trace.
 */
export function setupFailureReceipt({ runId, kind, prepared, candidate }) {
  return {
    schemaVersion: TRACE_RUN_SCHEMA,
    runKind: "trace",
    preview: false,
    runId,
    trace: { kind },
    head: prepared.head,
    headSha256: prepared.headSha256,
    candidate,
    status: "unmeasured",
    statusReasons: ["setup-failure"],
    b: "unmeasured",
    cp4Availability: "HOLD",
    setupFailure: prepared.setupFailure,
  };
}
