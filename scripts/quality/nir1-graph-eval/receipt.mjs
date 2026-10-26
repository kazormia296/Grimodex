// CP-4 run receipt (TASK §7.2): schema validator, the K2/4 declaration check,
// D3 measurement-window evidence, launch environment checks and SHA256SUMS.
//
// The validators are pure and recompute every derived value (declaration
// check, window assessment, aggregates) from the recorded rows instead of
// trusting the receipt's own claim. Only `writeSha256Sums` /
// `verifySha256Sums` read files; nothing here launches Electron, Xvfb or
// Native.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyGraphFixturePath } from "../nir1-retrieval/contract.mjs";
import {
  separateRequeries,
  summarizeSteadyStateCase,
  summarizeTrace,
  validateGraphCaseSchedule,
} from "./availability.mjs";
import { assessSocketSamples } from "./egress.mjs";
import {
  D2A_MODES,
  FROZEN_FIXTURE_SHA256,
  FROZEN_MATERIAL_SHA256,
  K62_FREEZE,
  K64_FREEZE,
  K64_R1_R4_WAIT_CEILING_MS,
  K64_T_LATE_MS,
  K64_T_SHOW_MS,
  K64_W_F_MS,
  WINDOW_SAMPLE_INTERVAL_MS,
  devVariant,
  variantByKey,
} from "./constants.mjs";
import { assessCandidateRegime } from "./followup.mjs";

export const CP4_RECEIPT_SCHEMA = "nir1-cp4-run-receipt/1";
export const RUN_KINDS = Object.freeze([
  "g-case-gold",
  "g-case-parity-unrestricted",
  "g-case-diagnostic-negative",
  "trace",
  "iii-diagnostic",
  "existing-24-compare",
  "g01-pair",
]);
/** Run kinds that observe R+IR+Graph (K2/4 negatives observe it too). */
export const GRAPH_RUN_KINDS = Object.freeze(
  new Set([
    "g-case-gold",
    "g-case-diagnostic-negative",
    "trace",
    "iii-diagnostic",
  ]),
);
const TRACE_RUN_KINDS = new Set(["trace", "iii-diagnostic"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestErrors(errors, value, label) {
  if (typeof value !== "string" || !SHA256.test(value))
    errors.push(`${label} must be a sha256`);
}

function commitErrors(errors, value, label) {
  if (typeof value !== "string" || !COMMIT.test(value))
    errors.push(`${label} must be a 40-hex commit`);
}

function indexMetadataErrors(errors, value, label) {
  for (const index of ["b", "chronicle"]) {
    if (!Number.isInteger(value?.[index]?.generation))
      errors.push(`${label}.${index}.generation must be an integer`);
    if (typeof value?.[index]?.dirty !== "boolean")
      errors.push(`${label}.${index}.dirty must be a boolean`);
  }
}

/** Stable JSON (sorted keys) for comparing recomputed values. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * K2/4 measurement-workspace check before the first Graph query (D1 (ii)).
 * A declaration that is not current, a seam binding that differs from the
 * declaration, or Index metadata that changed across the declaration step
 * stops before measuring with `[precheck]`; it is never turned into
 * `blocked` (N-5, N-6).
 */
export function assertDeclarationCurrent({
  declaration,
  measurementWorkspace,
}) {
  const errors = [];
  indexMetadataErrors(errors, declaration?.indexBefore, "indexBefore");
  indexMetadataErrors(errors, declaration?.indexAfter, "indexAfter");
  if (errors.length > 0)
    throw new Error(
      `[precheck] declaration record incomplete: ${errors.join("; ")}`,
    );
  for (const field of [
    "workspaceId",
    "canonicalLocatorDigest",
    "bindingDigest",
  ])
    if (
      typeof declaration?.[field] !== "string" ||
      declaration[field] !== measurementWorkspace?.[field]
    )
      throw new Error(
        `[precheck] the body declaration is not current for the measurement workspace (${field})`,
      );
  if (declaration.seamReceipt?.bindingDigest !== declaration.bindingDigest)
    throw new Error("[precheck] the seam receipt binds another declaration");
  for (const index of ["b", "chronicle"])
    for (const field of ["generation", "dirty"])
      if (
        declaration.indexBefore[index][field] !==
        declaration.indexAfter[index][field]
      )
        throw new Error(
          `[precheck] ${index} Index ${field} changed across the declaration step`,
        );
  return { proceed: true };
}

function windowSampleErrors(sample, at) {
  const errors = [];
  if (!Number.isFinite(sample?.atMs))
    errors.push(`window sample ${at} lacks atMs`);
  // P3-10: an unreadable /proc/locks or no slot file seen is not "0 in use".
  if (sample?.locksReadable !== true)
    errors.push(`window sample ${at} could not read /proc/locks`);
  if (!Number.isInteger(sample?.heavySlotFiles) || sample.heavySlotFiles <= 0)
    errors.push(`window sample ${at} saw no heavy.sh slot file`);
  if (!Number.isInteger(sample?.heavySlotsInUse))
    errors.push(`window sample ${at} lacks heavySlotsInUse`);
  if (!Array.isArray(sample?.buildProcesses))
    errors.push(`window sample ${at} lacks buildProcesses`);
  if (!Array.isArray(sample?.otherMeasurements))
    errors.push(`window sample ${at} lacks otherMeasurements`);
  if (typeof sample?.sameWorktreeBuild !== "boolean")
    errors.push(`window sample ${at} lacks sameWorktreeBuild`);
  return errors;
}

/**
 * D3: the window samples cover the run (before, after, gaps at most twice
 * the 20 s interval), every sample records every field, and none observes a
 * heavy build, test, other measurement or same-worktree build. The
 * harness's own processes are excluded by pid.
 */
export function assessMeasurementWindow({ samples, run, ownPids = [] }) {
  const violations = [];
  const gaps = [];
  if (!Array.isArray(samples)) gaps.push("window samples missing");
  const rows = Array.isArray(samples) ? samples : [];
  rows.forEach((sample, at) => gaps.push(...windowSampleErrors(sample, at)));
  if (!Number.isFinite(run?.startedAtMs) || !Number.isFinite(run?.finishedAtMs))
    gaps.push("run start/finish times missing");
  else if (run.finishedAtMs < run.startedAtMs)
    gaps.push("the run finishes before it starts");
  if (gaps.length > 0) return { clean: false, violations, gaps };
  const sorted = [...rows].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length < 2) gaps.push("fewer than two window samples");
  else {
    if (sorted[0].atMs > run.startedAtMs)
      gaps.push("no window sample before the run");
    if (sorted.at(-1).atMs < run.finishedAtMs)
      gaps.push("no window sample after the run");
    for (let at = 1; at < sorted.length; at++)
      if (sorted[at].atMs - sorted[at - 1].atMs > 2 * WINDOW_SAMPLE_INTERVAL_MS)
        gaps.push(`window samples ${at - 1} and ${at} are too far apart`);
  }
  const own = new Set(ownPids);
  for (const sample of sorted) {
    if (sample.heavySlotsInUse > 0)
      violations.push(`heavy slot in use at ${sample.atMs}`);
    for (const process of sample.buildProcesses)
      if (!own.has(process.pid))
        violations.push(`build process ${process.command} at ${sample.atMs}`);
    for (const other of sample.otherMeasurements)
      violations.push(`other measurement ${other} at ${sample.atMs}`);
    if (sample.sameWorktreeBuild)
      violations.push(`same-worktree build at ${sample.atMs}`);
  }
  return {
    clean: violations.length === 0 && gaps.length === 0,
    violations,
    gaps,
  };
}

/**
 * Splits receipts into those used for aggregation and those excluded with a
 * reason (N-14), recomputing each window assessment. Excluded receipts are
 * kept, never deleted.
 */
export function selectReceiptsForAggregation(receipts) {
  const included = [];
  const excluded = [];
  for (const receipt of receipts) {
    const window = assessMeasurementWindow({
      samples: receipt?.environment?.windowSamples,
      run: receipt?.run,
      ownPids: receipt?.environment?.ownPids ?? [],
    });
    if (!window.clean)
      excluded.push({
        runId: receipt?.runId ?? null,
        reason: "measurement-window-requirement-not-met",
        violations: window.violations,
        gaps: window.gaps,
      });
    else included.push(receipt);
  }
  return { included, excluded };
}

const DESKTOP_ENV = [
  "WAYLAND_DISPLAY",
  "WAYLAND_SOCKET",
  "DBUS_SESSION_BUS_ADDRESS",
];

function netnsArgv(argv) {
  return argv.some(
    (arg, at) =>
      /(^|\/)(unshare|nsenter|firejail)$/u.test(arg) ||
      /^--unshare-(net|all)$/u.test(arg) ||
      /^--net(=|$)/u.test(arg) ||
      (arg === "netns" && /(^|\/)ip$/u.test(argv[at - 1] ?? "")),
  );
}

function ozoneArgv(argv) {
  return argv.some(
    (arg, at) =>
      (/^--ozone-platform=/u.test(arg) && arg !== "--ozone-platform=x11") ||
      (arg === "--ozone-platform" && argv[at + 1] !== "x11") ||
      /^--enable-features=.*(UseOzonePlatform|WaylandWindowDecorations)/u.test(
        arg,
      ),
  );
}

/**
 * §8 / §13 P-9 / §15.7: Electron launches on the run's Xvfb display (never
 * `:0`), without Wayland or the session D-Bus, with the X11 ozone hint and
 * no ozone override in argv, and in the parent's network namespace (N-11).
 * `netns` is readNetNamespaces() of the launching harness.
 */
export function assertElectronLaunch({ env, argv = [], xvfbDisplay, netns }) {
  if (typeof xvfbDisplay !== "string" || !/^:\d+$/u.test(xvfbDisplay))
    throw new Error("[precheck] the run's Xvfb display number is required");
  if (xvfbDisplay === ":0" || env?.DISPLAY !== xvfbDisplay)
    throw new Error(
      "[precheck] Electron must draw only on the run's Xvfb display, never :0",
    );
  for (const name of DESKTOP_ENV)
    if (env?.[name] !== undefined)
      throw new Error(`[precheck] Electron launch env still carries ${name}`);
  if (env?.XDG_SESSION_TYPE === "wayland")
    throw new Error("[precheck] Electron launch env is a Wayland session");
  if (env?.ELECTRON_OZONE_PLATFORM_HINT !== "x11")
    throw new Error(
      "[precheck] Electron launch env must set the x11 ozone hint",
    );
  if (ozoneArgv(argv))
    throw new Error("[precheck] argv must not override the x11 ozone platform");
  if (netnsArgv(argv))
    throw new Error(
      "[precheck] Xvfb/Electron must not start inside a network namespace",
    );
  if (
    !netns ||
    (!netns.unavailable && (!netns.self || netns.self !== netns.parent))
  )
    throw new Error(
      "[precheck] the harness is not in its parent's network namespace",
    );
  return { removedEnv: [...DESKTOP_ENV], display: xvfbDisplay };
}

/**
 * The head every receipt writes before measuring (K6/2 "事前登録の凍結" 2,
 * read with K6/4 批准 7: a formal R+IR+Graph run writes the K6/4 freeze
 * commit and bytes; a receipt with only K6/2 at its head is a preview). The
 * K6/2 bytes stay as the baseline the /4 row amends. Until the integrator
 * pins the K6/4 freeze commit (K64_FREEZE.freezeCommit), no formal Graph
 * receipt validates.
 */
export function receiptHeadErrors(head, runKind, fixtureKind) {
  const errors = [];
  if (head?.k62?.freezeCommit !== K62_FREEZE.commit)
    errors.push("head.k62.freezeCommit must be the K6/2 freeze commit");
  if (head?.k62?.sha256 !== K62_FREEZE.sha256)
    errors.push("head.k62.sha256 must be the K6/2 bytes read from that commit");
  const formalGraph = GRAPH_RUN_KINDS.has(runKind) && fixtureKind !== "dev";
  if (formalGraph || head?.k64 !== undefined) {
    if (head?.k64?.sha256 !== K64_FREEZE.sha256)
      errors.push("head.k64.sha256 must be the K6/4 bytes (批准 7)");
    commitErrors(errors, head?.k64?.freezeCommit, "head.k64.freezeCommit");
    if (formalGraph) {
      if (K64_FREEZE.freezeCommit === null)
        errors.push(
          "[precheck] the K6/4 freeze commit is not pinned (批准 7: the integrator freezes K6/4 on claude/nir1-contracts first); a formal Graph receipt is refused",
        );
      else if (head?.k64?.freezeCommit !== K64_FREEZE.freezeCommit)
        errors.push(
          "head.k64.freezeCommit must be the pinned K6/4 freeze commit",
        );
    }
  }
  if (
    typeof head?.runStartedAtUtc !== "string" ||
    !ISO_UTC.test(head.runStartedAtUtc)
  )
    errors.push("head.runStartedAtUtc must be an ISO UTC time");
  if (GRAPH_RUN_KINDS.has(runKind) && fixtureKind !== "dev") {
    commitErrors(
      errors,
      head?.observationPrep?.commit,
      "head.observationPrep.commit",
    );
    digestErrors(
      errors,
      head?.observationPrep?.freezeRecordSha256,
      "head.observationPrep.freezeRecordSha256",
    );
  }
  if (TRACE_RUN_KINDS.has(runKind)) {
    commitErrors(errors, head?.traceFile?.commit, "head.traceFile.commit");
    digestErrors(errors, head?.traceFile?.sha256, "head.traceFile.sha256");
  }
  return errors;
}

/**
 * The run's variant from its fixture block: a catalog variant whose fixture
 * path and frozen digest match, or a declared dev variant on a dev fixture
 * that is not a copy of frozen material.
 */
export function resolveRunVariant(receipt) {
  const fixture = receipt?.fixture;
  const kind = classifyGraphFixturePath(fixture?.path);
  if (fixture.kind !== kind)
    throw new Error(
      `[precheck] fixture.kind must be ${kind} for ${fixture.path}`,
    );
  if (typeof fixture.sha256 !== "string" || !SHA256.test(fixture.sha256))
    throw new Error("[precheck] fixture.sha256 must be a sha256");
  if (kind === "frozen") {
    const variant = variantByKey(receipt.settings?.variantKey);
    if (
      variant.fixturePath !== fixture.path ||
      FROZEN_FIXTURE_SHA256[fixture.path] !== fixture.sha256
    )
      throw new Error(
        "[precheck] the variant, fixture path and frozen digest do not match",
      );
    return variant;
  }
  if (FROZEN_MATERIAL_SHA256.has(fixture.sha256))
    throw new Error(
      "[precheck] a dev fixture must not be a copy of frozen material",
    );
  const variant = devVariant(receipt.settings?.devVariant ?? {});
  if (variant.key !== receipt.settings?.variantKey)
    throw new Error(
      "[precheck] settings.variantKey must be the declared dev variant",
    );
  return variant;
}

/**
 * The aggregates a receipt must carry, recomputed from its rows. Graph-free
 * run kinds only count rows; the R+IR+Graph runs recompute the (a) case
 * entry or the (b) trace summary.
 */
export function computeRunAggregates(receipt, variant) {
  const samples = receipt.samples ?? [];
  const requeries = receipt.requeries ?? [];
  const graphSamples = samples.filter((row) => row.arm === "graph").length;
  // A K6/4-era receipt records the 批准 5 evidence; its regime is recomputed
  // here and in the summaries (N31). Without it the receipt is K6/2-era.
  const k64 =
    receipt.candidate && Object.hasOwn(receipt.candidate, "ratification5")
      ? { candidate: receipt.candidate.ratification5 }
      : null;
  const regime = k64
    ? { candidateRegime: assessCandidateRegime(k64.candidate) }
    : {};
  switch (receipt.runKind) {
    case "g-case-gold": {
      validateGraphCaseSchedule(samples, [variant.key]);
      const { entry, invalid } = summarizeSteadyStateCase({
        rows: samples,
        variant,
        fixedGraphMode: receipt.settings?.d2aModes?.graph,
        ...(k64 ?? {}),
      });
      return {
        steadyStateCase: entry,
        invalid,
        requeryCount: requeries.length,
        ...regime,
      };
    }
    case "trace":
    case "iii-diagnostic":
      return {
        trace: summarizeTrace({
          trace: {
            kind: receipt.settings?.traceKind,
            queries: [...samples, ...requeries],
          },
          fixedGraphMode: receipt.settings?.d2aModes?.graph,
          ...(k64 ?? {}),
        }),
        ...regime,
      };
    default:
      separateRequeries(requeries);
      return {
        sampleCount: samples.length,
        graphSampleCount: graphSamples,
        requeryCount: requeries.length,
      };
  }
}

/**
 * The verdict one run receipt may carry, recomputed (P2-6). A run receipt
 * never decides CP-4: a formal run is `recorded` for the pooled decision
 * (decideCp4Availability over the receipts; the pool, never a case rate,
 * N21), a dev or predeclared preview is `preview-only`, a run whose
 * aggregates are invalid is `invalid` (kept as a record, never valid), and a
 * K6/4 trace whose reading K6/4 leaves open is `precheck`.
 */
export function computeRunVerdict(receipt, variant, aggregates) {
  const invalid = [
    ...(aggregates?.invalid ?? []),
    ...(aggregates?.trace?.status === "invalid"
      ? (aggregates.trace.invalid ?? ["trace-invalid"])
      : []),
  ];
  if (invalid.length > 0) return { outcome: "invalid" };
  if (variant?.kind === "dev" || receipt?.preview === true)
    return { outcome: "preview-only" };
  if (aggregates?.trace?.status === "precheck") return { outcome: "precheck" };
  return { outcome: "recorded" };
}

/** settings.k64 of a formal K6/4 Graph run (K6/4 変える点 16, 技術点 2; N17). */
function k64SettingsErrors(errors, value) {
  if (
    value?.wFMs !== K64_W_F_MS ||
    value?.tLateMs !== K64_T_LATE_MS ||
    value?.tShowMs !== K64_T_SHOW_MS
  )
    errors.push(
      `N17: settings.k64 must carry W_f ${K64_W_F_MS} ms, T_late ${K64_T_LATE_MS} ms and T_show ${K64_T_SHOW_MS} ms as frozen (narrowing needs a new procedure-file version and review, widening a new draftRef; neither is supported here)`,
    );
  if (
    !Number.isInteger(value?.r1r4WaitMs) ||
    value.r1r4WaitMs <= 0 ||
    value.r1r4WaitMs > K64_R1_R4_WAIT_CEILING_MS
  )
    errors.push(
      "settings.k64.r1r4WaitMs must be the procedure file's R1/R4 wait bound, at most 10 s (技術点 2)",
    );
  const file = value?.procedureFile;
  if (typeof file?.path !== "string" || file.path.length === 0)
    errors.push("settings.k64.procedureFile must name the procedure file");
  commitErrors(errors, file?.commit, "settings.k64.procedureFile.commit");
  digestErrors(errors, file?.sha256, "settings.k64.procedureFile.sha256");
}

/**
 * Validates the §7.2 minimum set of one run receipt. Returns error strings;
 * `assertCp4Receipt` throws them as `[precheck]`.
 */
export function validateCp4Receipt(receipt) {
  const errors = [];
  if (receipt?.schemaVersion !== CP4_RECEIPT_SCHEMA)
    errors.push(`schemaVersion must be ${CP4_RECEIPT_SCHEMA}`);
  if (!RUN_KINDS.includes(receipt?.runKind))
    errors.push(`runKind must be one of ${RUN_KINDS.join(", ")}`);
  const graphRun = GRAPH_RUN_KINDS.has(receipt?.runKind);
  if (typeof receipt?.runId !== "string" || receipt.runId.length === 0)
    errors.push("runId is required");
  if (typeof receipt?.preview !== "boolean")
    errors.push(
      "preview must record whether this is a predeclared preview run",
    );

  let variant = null;
  if (receipt?.runKind !== "existing-24-compare") {
    try {
      variant = resolveRunVariant(receipt);
    } catch (error) {
      errors.push(error.message);
    }
    if (variant?.kind === "dev" && receipt.preview !== true)
      errors.push("a dev-fixture run is always a preview");
  } else if (receipt?.fixture !== undefined && receipt.fixture !== null)
    errors.push("the existing 24 queries carry no G-case fixture");
  errors.push(
    ...receiptHeadErrors(receipt?.head, receipt?.runKind, variant?.kind),
  );

  const candidate = receipt?.candidate;
  commitErrors(errors, candidate?.commit, "candidate.commit");
  commitErrors(errors, candidate?.tree, "candidate.tree");
  if (candidate?.clean !== true) errors.push("candidate.clean must be true");
  digestErrors(
    errors,
    candidate?.productReceiptSha256,
    "candidate.productReceiptSha256",
  );
  if (graphRun) {
    digestErrors(
      errors,
      candidate?.evalReceiptSha256,
      "candidate.evalReceiptSha256",
    );
    digestErrors(errors, candidate?.workerSha256, "candidate.workerSha256");
    if (
      !Array.isArray(candidate?.features) ||
      candidate.features.length !== 1 ||
      candidate.features[0] !== "nir1-graph-eval"
    )
      errors.push(
        'candidate.features must be exactly the evaluation feature set ["nir1-graph-eval"]',
      );
    if (variant?.kind !== "dev") {
      if (
        !candidate?.ratification5 ||
        typeof candidate.ratification5 !== "object"
      )
        errors.push(
          "candidate.ratification5 must record 批准 5 (a) D′, (b) the RS-JOIN hook, (c) W_f (N31)",
        );
      k64SettingsErrors(errors, receipt?.settings?.k64);
    }
  }
  for (const language of ["ja", "en"]) {
    digestErrors(
      errors,
      candidate?.models?.[language]?.modelSha256,
      `candidate.models.${language}.modelSha256`,
    );
    digestErrors(
      errors,
      candidate?.models?.[language]?.tokenizerSha256,
      `candidate.models.${language}.tokenizerSha256`,
    );
  }
  if (typeof candidate?.electronVersion !== "string")
    errors.push("candidate.electronVersion is required");
  if (
    !candidate?.harnessFiles ||
    Object.keys(candidate.harnessFiles).length === 0
  )
    errors.push("candidate.harnessFiles must list the harness file digests");
  else
    for (const [file, digest] of Object.entries(candidate.harnessFiles))
      digestErrors(errors, digest, `candidate.harnessFiles[${file}]`);

  const environment = receipt?.environment;
  if (!environment?.hostSnapshot)
    errors.push("environment.hostSnapshot is required");
  const window = assessMeasurementWindow({
    samples: environment?.windowSamples,
    run: receipt?.run,
    ownPids: environment?.ownPids ?? [],
  });
  if (stable(window) !== stable(environment?.windowAssessment))
    errors.push(
      "environment.windowAssessment differs from the recomputed window samples",
    );
  if (
    !/^:\d+$/u.test(environment?.xvfbDisplay ?? "") ||
    environment?.xvfbDisplay === ":0"
  )
    errors.push(
      "environment.xvfbDisplay must be the run's display number, never :0",
    );
  if (!Array.isArray(environment?.removedEnv))
    errors.push("environment.removedEnv must list removed env names");
  digestErrors(
    errors,
    environment?.netLog?.sha256,
    "environment.netLog.sha256",
  );
  if (environment?.netLog?.nonLoopbackAttempts !== 0)
    errors.push(
      "[precheck] N-12: the net log shows (or lacks the count of) non-loopback attempts",
    );
  // §15.1: the socket samples see what the net log cannot (Native reqwest,
  // the Main's Node). An external socket is a new-receiver suspicion.
  const sockets = assessSocketSamples({
    samples: environment?.socketSamples,
    run: receipt?.run,
  });
  for (const gap of sockets.gaps)
    errors.push(`environment.socketSamples: ${gap}`);
  if (sockets.violations.length > 0)
    errors.push(
      `[precheck] the Electron process tree had an external socket: ${sockets.violations.join("; ")}`,
    );

  const settings = receipt?.settings;
  for (const arm of ["raw", "hybrid", "graph"])
    if (
      settings?.d2aModes?.[arm] !== undefined &&
      !D2A_MODES.includes(settings.d2aModes[arm])
    )
      errors.push(`settings.d2aModes.${arm} is not a D2a mode`);
  if (!settings?.d2aModes?.hybrid)
    errors.push("settings.d2aModes.hybrid is required");
  if (graphRun && settings?.d2aModes?.graph !== "restricted")
    errors.push("the R+IR+Graph arm is measured restricted (D10)");
  if (!settings?.reauthorization)
    errors.push("settings.reauthorization breakdown is required");
  if (
    receipt?.runKind !== "existing-24-compare" &&
    !settings?.setupReceipt?.logicalToRuntime
  )
    errors.push("settings.setupReceipt.logicalToRuntime is required");

  if (receipt?.runKind === "g-case-gold" && variant?.declaration) {
    const declaration = receipt?.declaration;
    for (const field of [
      "workspaceId",
      "canonicalLocatorDigest",
      "token",
      "bindingDigest",
    ])
      if (
        typeof declaration?.[field] !== "string" ||
        declaration[field].length === 0
      )
        errors.push(`declaration.${field} is required for a declaration run`);
    const seam = declaration?.seamReceipt;
    if (typeof seam?.version !== "string")
      errors.push("declaration.seamReceipt.version is required");
    if (!Array.isArray(seam?.envNames))
      errors.push("declaration.seamReceipt.envNames is required");
    digestErrors(
      errors,
      seam?.nonceDigest,
      "declaration.seamReceipt.nonceDigest",
    );
    if (!Number.isInteger(seam?.approvedGrantCount))
      errors.push("declaration.seamReceipt.approvedGrantCount is required");
    digestErrors(
      errors,
      seam?.bindingDigest,
      "declaration.seamReceipt.bindingDigest",
    );
    if (declaration?.verified !== true)
      errors.push(
        "declaration.verified must be true before the first Graph query",
      );
    try {
      assertDeclarationCurrent({
        declaration,
        measurementWorkspace: receipt?.measurementWorkspace,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  const samples = receipt?.samples;
  if (!Array.isArray(samples)) errors.push("samples must be an array");
  if (!Array.isArray(receipt?.requeries))
    errors.push("requeries must be a separate array (D5/A3 column)");
  else if (receipt.requeries.some((row) => row.trigger === "user-operation"))
    errors.push("requeries must not hold user-operation queries");
  if (
    Array.isArray(samples) &&
    samples.some((row) => row.trigger !== "user-operation")
  )
    errors.push("samples must not hold re-query rows");
  if (Array.isArray(samples) && !graphRun) {
    const graphRows = samples.filter((row) => row.arm === "graph");
    if (receipt.runKind !== "existing-24-compare" && graphRows.length > 0)
      errors.push(`${receipt.runKind} does not run the R+IR+Graph arm`);
    if (
      receipt.runKind === "existing-24-compare" &&
      graphRows.some(
        (row) =>
          row.graph?.status !== "not-requested" ||
          (row.graph?.seed ?? null) !== null,
      )
    )
      errors.push(
        "the existing queries' Graph arm is only ever not-requested without a seed",
      );
  }
  if (!receipt?.aggregates) errors.push("aggregates are required");
  else if (
    Array.isArray(samples) &&
    Array.isArray(receipt.requeries) &&
    (variant || receipt.runKind === "existing-24-compare")
  ) {
    try {
      const recomputed = computeRunAggregates(receipt, variant);
      if (stable(recomputed) !== stable(receipt.aggregates))
        errors.push(
          "aggregates differ from the values recomputed from the samples",
        );
      const verdict = computeRunVerdict(receipt, variant, recomputed);
      if (verdict.outcome === "invalid")
        errors.push(
          "this is an invalid run (its aggregates name invalid samples); it is kept as a record and never validates (P2-6)",
        );
      if (receipt?.verdict?.outcome !== verdict.outcome)
        errors.push(
          `verdict.outcome must be the recomputed ${verdict.outcome} (P2-6)`,
        );
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!receipt?.verdict?.outcome) errors.push("verdict.outcome is required");
  return errors;
}

export function assertCp4Receipt(receipt) {
  const errors = validateCp4Receipt(receipt);
  if (errors.length > 0)
    throw new Error(`[precheck] CP-4 receipt invalid: ${errors.join("; ")}`);
  return receipt;
}

function safeRelative(file) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    path.isAbsolute(file) ||
    file.split(/[\\/]/u).includes("..") ||
    /[\n\r]/u.test(file)
  )
    throw new Error(`[artifact] unsafe SHA256SUMS path: ${file}`);
  return file;
}

/** `sha256sum -c` compatible text (two spaces, sorted, LF). */
export function formatSha256Sums(entries) {
  const rows = entries.map(({ path: file, sha256: digest }) => {
    safeRelative(file);
    if (!SHA256.test(digest))
      throw new Error(`[artifact] bad digest for ${file}`);
    if (path.basename(file) === "SHA256SUMS")
      throw new Error("[artifact] SHA256SUMS must not list itself");
    return [file, digest];
  });
  const names = rows.map(([file]) => file);
  if (new Set(names).size !== names.length)
    throw new Error("[artifact] duplicate SHA256SUMS path");
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return rows.map(([file, digest]) => `${digest}  ${file}\n`).join("");
}

export function parseSha256Sums(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match)
      throw new Error(`[artifact] malformed SHA256SUMS line: ${line}`);
    entries.push({ path: safeRelative(match[2]), sha256: match[1] });
  }
  return entries;
}

export async function writeSha256Sums(directory, files) {
  const entries = [];
  for (const file of files)
    entries.push({
      path: safeRelative(file),
      sha256: sha256(await readFile(path.join(directory, file))),
    });
  const text = formatSha256Sums(entries);
  await writeFile(path.join(directory, "SHA256SUMS"), text, { flag: "wx" });
  return text;
}

export async function verifySha256Sums(directory, text) {
  const mismatched = [];
  const missing = [];
  for (const entry of parseSha256Sums(text)) {
    let bytes;
    try {
      bytes = await readFile(path.join(directory, entry.path));
    } catch {
      missing.push(entry.path);
      continue;
    }
    if (sha256(bytes) !== entry.sha256) mismatched.push(entry.path);
  }
  return {
    ok: mismatched.length === 0 && missing.length === 0,
    mismatched,
    missing,
  };
}
