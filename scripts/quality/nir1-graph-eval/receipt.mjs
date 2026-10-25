// CP-4 run receipt (TASK §7.2): schema validator, the K2/4 declaration check,
// D3 measurement-window evidence, launch environment checks and SHA256SUMS.
//
// The validators are pure. Only `writeSha256Sums` / `verifySha256Sums` read
// files; nothing here launches Electron, Xvfb or Native.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  D2A_MODES,
  K62_FREEZE,
  WINDOW_SAMPLE_INTERVAL_MS,
  variantByKey,
} from "./constants.mjs";

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
const GRAPH_RUN_KINDS = new Set(["g-case-gold", "trace", "iii-diagnostic"]);
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

/**
 * K2/4 measurement-workspace check before the first Graph query (D1 (ii)).
 * A declaration that is not current, or Index metadata that changed across
 * the declaration step, stops before measuring with `[precheck]`; it is
 * never turned into `blocked` (N-5, N-6).
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

/**
 * D3: the window samples cover the run (before, after, gaps at most twice
 * the 20 s interval) and observe no heavy build, test, other measurement or
 * same-worktree build. The harness's own processes are excluded by pid.
 */
export function assessMeasurementWindow({ samples, run, ownPids = [] }) {
  const violations = [];
  const gaps = [];
  const sorted = [...(samples ?? [])].sort((a, b) => a.atMs - b.atMs);
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
    if ((sample.heavySlotsInUse ?? 0) > 0)
      violations.push(`heavy slot in use at ${sample.atMs}`);
    for (const process of sample.buildProcesses ?? [])
      if (!own.has(process.pid))
        violations.push(`build process ${process.command} at ${sample.atMs}`);
    for (const other of sample.otherMeasurements ?? [])
      violations.push(`other measurement ${other} at ${sample.atMs}`);
    if (sample.sameWorktreeBuild === true)
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
 * reason (N-14). Excluded receipts are kept, never deleted.
 */
export function selectReceiptsForAggregation(receipts) {
  const included = [];
  const excluded = [];
  for (const receipt of receipts) {
    const window = receipt?.environment?.windowAssessment;
    if (!window?.clean)
      excluded.push({
        runId: receipt?.runId ?? null,
        reason: "measurement-window-requirement-not-met",
        violations: window?.violations ?? [],
        gaps: window?.gaps ?? ["window assessment missing"],
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

/**
 * §8 / §15.7: Electron launches without Wayland or the session D-Bus, with
 * the X11 ozone hint, outside a network namespace (N-11).
 */
export function assertElectronLaunch({ env, argv = [] }) {
  for (const name of DESKTOP_ENV)
    if (env?.[name] !== undefined)
      throw new Error(`[precheck] Electron launch env still carries ${name}`);
  if (env?.XDG_SESSION_TYPE === "wayland")
    throw new Error("[precheck] Electron launch env is a Wayland session");
  if (env?.ELECTRON_OZONE_PLATFORM_HINT !== "x11")
    throw new Error(
      "[precheck] Electron launch env must set the x11 ozone hint",
    );
  if (
    argv.some((arg) => /(^|\/)(unshare|nsenter)$/u.test(arg)) ||
    argv.some(
      (arg, at) => arg === "netns" && /(^|\/)ip$/u.test(argv[at - 1] ?? ""),
    )
  )
    throw new Error(
      "[precheck] Xvfb/Electron must not start inside a network namespace",
    );
  return { removedEnv: [...DESKTOP_ENV] };
}

/** The head every receipt writes before measuring (K6/2 "事前登録の凍結" 2). */
export function receiptHeadErrors(head, runKind) {
  const errors = [];
  if (head?.k62?.freezeCommit !== K62_FREEZE.commit)
    errors.push("head.k62.freezeCommit must be the K6/2 freeze commit");
  if (head?.k62?.sha256 !== K62_FREEZE.sha256)
    errors.push("head.k62.sha256 must be the K6/2 bytes read from that commit");
  if (
    typeof head?.runStartedAtUtc !== "string" ||
    !ISO_UTC.test(head.runStartedAtUtc)
  )
    errors.push("head.runStartedAtUtc must be an ISO UTC time");
  if (GRAPH_RUN_KINDS.has(runKind)) {
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
 * Validates the §7.2 minimum set of one run receipt. Returns error strings;
 * `assertCp4Receipt` throws them as `[precheck]`.
 */
export function validateCp4Receipt(receipt) {
  const errors = [];
  if (receipt?.schemaVersion !== CP4_RECEIPT_SCHEMA)
    errors.push(`schemaVersion must be ${CP4_RECEIPT_SCHEMA}`);
  if (!RUN_KINDS.includes(receipt?.runKind))
    errors.push(`runKind must be one of ${RUN_KINDS.join(", ")}`);
  if (typeof receipt?.runId !== "string" || receipt.runId.length === 0)
    errors.push("runId is required");
  if (typeof receipt?.preview !== "boolean")
    errors.push(
      "preview must record whether this is a predeclared preview run",
    );
  errors.push(...receiptHeadErrors(receipt?.head, receipt?.runKind));

  const candidate = receipt?.candidate;
  commitErrors(errors, candidate?.commit, "candidate.commit");
  commitErrors(errors, candidate?.tree, "candidate.tree");
  if (candidate?.clean !== true) errors.push("candidate.clean must be true");
  digestErrors(
    errors,
    candidate?.productReceiptSha256,
    "candidate.productReceiptSha256",
  );
  if (GRAPH_RUN_KINDS.has(receipt?.runKind)) {
    digestErrors(
      errors,
      candidate?.evalReceiptSha256,
      "candidate.evalReceiptSha256",
    );
    digestErrors(errors, candidate?.workerSha256, "candidate.workerSha256");
    if (
      !Array.isArray(candidate?.features) ||
      !candidate.features.includes("nir1-graph-eval")
    )
      errors.push("candidate.features must record the evaluation feature set");
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
  if (!Array.isArray(environment?.windowSamples))
    errors.push("environment.windowSamples must be an array");
  if (typeof environment?.windowAssessment?.clean !== "boolean")
    errors.push("environment.windowAssessment is required");
  if (!/^:\d+$/u.test(environment?.xvfbDisplay ?? ""))
    errors.push("environment.xvfbDisplay must be the display number only");
  if (!Array.isArray(environment?.removedEnv))
    errors.push("environment.removedEnv must list removed env names");
  digestErrors(
    errors,
    environment?.netLog?.sha256,
    "environment.netLog.sha256",
  );
  if (!Number.isInteger(environment?.netLog?.nonLoopbackAttempts))
    errors.push("environment.netLog.nonLoopbackAttempts is required");
  if (!Array.isArray(environment?.socketSamples))
    errors.push("environment.socketSamples must record non-Chromium sockets");

  const settings = receipt?.settings;
  if (receipt?.runKind !== "existing-24-compare") {
    try {
      variantByKey(settings?.variantKey);
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const arm of ["raw", "hybrid", "graph"])
    if (
      settings?.d2aModes?.[arm] !== undefined &&
      !D2A_MODES.includes(settings.d2aModes[arm])
    )
      errors.push(`settings.d2aModes.${arm} is not a D2a mode`);
  if (!settings?.d2aModes?.hybrid)
    errors.push("settings.d2aModes.hybrid is required");
  if (
    GRAPH_RUN_KINDS.has(receipt?.runKind) &&
    settings?.d2aModes?.graph !== "restricted"
  )
    errors.push("the R+IR+Graph arm is measured restricted (D10)");
  if (!settings?.reauthorization)
    errors.push("settings.reauthorization breakdown is required");
  if (
    receipt?.runKind !== "existing-24-compare" &&
    !settings?.setupReceipt?.logicalToRuntime
  )
    errors.push("settings.setupReceipt.logicalToRuntime is required");

  if (
    receipt?.runKind === "g-case-gold" &&
    settings?.variantKey &&
    (() => {
      try {
        return variantByKey(settings.variantKey).declaration;
      } catch {
        return false;
      }
    })()
  ) {
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
    indexMetadataErrors(
      errors,
      declaration?.indexBefore,
      "declaration.indexBefore",
    );
    indexMetadataErrors(
      errors,
      declaration?.indexAfter,
      "declaration.indexAfter",
    );
    if (declaration?.verified !== true)
      errors.push(
        "declaration.verified must be true before the first Graph query",
      );
  }

  if (!Array.isArray(receipt?.samples)) errors.push("samples must be an array");
  if (!Array.isArray(receipt?.requeries))
    errors.push("requeries must be a separate array (D5/A3 column)");
  else if (receipt.requeries.some((row) => row.trigger === "user-operation"))
    errors.push("requeries must not hold user-operation queries");
  if (
    Array.isArray(receipt?.samples) &&
    receipt.samples.some((row) => row.trigger !== "user-operation")
  )
    errors.push("samples must not hold re-query rows");
  if (!receipt?.aggregates) errors.push("aggregates are required");
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
