// The evaluation build of the Native for CP-4 (S1a; TASK D8, D9, §15.2).
//
// It builds `grimodex-node` with the evaluation-only `nir1-graph-eval` feature
// and the product C-query worker, and writes both into one directory under
// `.artifacts/` (default `.artifacts/cp4/eval-build/`):
//
//   <out>/grimodex-node.node     the evaluation `.node` (never the default
//                                `electron/native/grimodex-node/grimodex-node.node`)
//   <out>/index.d.ts             napi's declarations of that build (never the
//                                tracked `electron/native/grimodex-node/index.d.ts`)
//   <out>/nir1-c-query-worker    the worker, at the fixed name the evaluation
//                                `.node` resolves next to itself
//   <out>/eval-build.json        the manifest: features, commands, sha256s
//
// It refuses an output directory outside `.artifacts/` or inside the
// grimodex-node package, and checks after the build that the default `.node`
// and the tracked declarations did not change, that the evaluation `.node`
// reports `nir1GraphEval: true` and exports exactly the evaluation functions,
// and that it carries every evaluation marker string.
//
// Run it only in a clean candidate worktree, through the scratchpad's
// `heavy.sh` (one cargo slot for both builds), in a window without other
// measurements. Linux only (the cdylib is `libgrimodex_node.so`). The
// evaluation `.node` is never distributed.
//
//   heavy.sh node scripts/quality/nir1-graph-eval/eval-native-build.mjs [--out .artifacts/cp4/eval-build]

import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runLocalCiCommand } from "../../local-ci-process-supervisor.mjs";
import {
  captureCandidate,
  cleanStatus,
  sameCandidate,
  sourceDigests,
  sourcePaths,
} from "../nir1-retrieval/standard-build.mjs";
import {
  EVAL_FEATURE,
  EVAL_NAPI_EXPORTS,
  NODE_CAPABILITY_FLAG,
  scanNativeBinary,
} from "./native-architecture.mjs";

export const MANIFEST_SCHEMA = "nir1-graph-eval-build/1";
export const DEFAULT_OUT_DIR = ".artifacts/cp4/eval-build";
export const NATIVE_DIR = "electron/native/grimodex-node";
export const DEFAULT_NODE = `${NATIVE_DIR}/grimodex-node.node`;
export const TRACKED_DECLARATIONS = `${NATIVE_DIR}/index.d.ts`;
export const NODE_FILE_NAME = "grimodex-node.node";
export const WORKER_FILE_NAME = "nir1-c-query-worker";
export const WORKER_ARTIFACT = `src-tauri/target/release/${WORKER_FILE_NAME}`;
const COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const GRACE_MS = 2_000;

const precheck = (message) => new Error(`[precheck] ${message}`);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The absolute output directory: exactly `<root>/.artifacts/cp4/eval-build`
 * (the only directory the Graph arm's receipt guard accepts). The other
 * checks stay as a second line.
 */
export function resolveEvalOutputDir(root, outDir = DEFAULT_OUT_DIR) {
  assert.ok(path.isAbsolute(root), "root must be absolute");
  const out = path.resolve(root, outDir);
  const artifacts = path.join(root, ".artifacts");
  if (!isInside(artifacts, out) || out === artifacts) {
    throw precheck(
      `the evaluation build must be written under .artifacts/ (got ${out})`,
    );
  }
  if (out !== path.join(root, DEFAULT_OUT_DIR)) {
    throw precheck(
      `the evaluation build is written to ${DEFAULT_OUT_DIR} only (got ${out})`,
    );
  }
  if (isInside(path.join(root, NATIVE_DIR), out)) {
    throw precheck(
      "the evaluation build must not be written inside the grimodex-node package",
    );
  }
  if (path.join(out, NODE_FILE_NAME) === path.join(root, DEFAULT_NODE)) {
    throw precheck("the evaluation .node must not replace the default .node");
  }
  return out;
}

/** The two builds and the copies, without running anything. */
export function planEvalNativeBuild({ root, outDir = DEFAULT_OUT_DIR }) {
  const out = resolveEvalOutputDir(root, outDir);
  // napi joins its cwd with the destination for the declarations, so the
  // destination is given relative to the package directory.
  const destination = path.relative(path.join(root, NATIVE_DIR), out);
  return {
    out,
    features: [EVAL_FEATURE],
    commands: [
      {
        id: "eval-native",
        command: "pnpm",
        args: [
          "--dir",
          NATIVE_DIR,
          "exec",
          "napi",
          "build",
          "--release",
          "--features",
          EVAL_FEATURE,
          "--js",
          "false",
          destination,
        ],
        cwd: ".",
      },
      {
        id: "c-query-worker",
        command: "cargo",
        args: [
          "build",
          "--release",
          "--manifest-path",
          "src-tauri/Cargo.toml",
          "-p",
          "grimodex-db",
          "--bin",
          WORKER_FILE_NAME,
        ],
        cwd: ".",
      },
    ],
    outputs: {
      node: path.join(out, NODE_FILE_NAME),
      declarations: path.join(out, "index.d.ts"),
      worker: path.join(out, WORKER_FILE_NAME),
      manifest: path.join(out, "eval-build.json"),
    },
    copies: [
      {
        from: path.join(root, WORKER_ARTIFACT),
        to: path.join(out, WORKER_FILE_NAME),
      },
    ],
  };
}

export function commandStatus(result) {
  if (!result) return "not-started";
  if (result.closeObserved === false) return "termination-unknown";
  if (result.interrupted) return "interrupted";
  if (result.timedOut) return "timed-out";
  if (result.error) return "spawn-error";
  return result.exitCode === 0 &&
    result.signal === null &&
    result.cleanup?.complete === true &&
    result.termination === "close-and-group-exit-observed"
    ? "passed"
    : "failed";
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function optionalSha256(file) {
  try {
    return await sha256File(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Loads the evaluation `.node` in a separate Node process and reports its
 * capabilities and its `nir1GraphEval*` exports.
 */
export function inspectEvalModule(nodeFile) {
  const script = `
    const native = require(${JSON.stringify(nodeFile)});
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grimodex-eval-native-"));
    try {
      const backend = new native.Backend(temp);
      backend.getNativeBuildCapabilities().then((caps) => {
        process.stdout.write(JSON.stringify({
          capabilities: JSON.parse(caps),
          exports: Object.keys(native).filter((name) => name.startsWith("nir1GraphEval")).sort(),
        }));
      }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
    } catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error; }
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/** The checks on a finished evaluation build. Returns violations. */
export function verifyEvalBuild({
  inspection,
  binary,
  defaultNodeBefore,
  defaultNodeAfter,
  declarationsBefore,
  declarationsAfter,
}) {
  const violations = [];
  if (inspection.capabilities?.[NODE_CAPABILITY_FLAG] !== true) {
    violations.push(
      `the evaluation .node must report ${NODE_CAPABILITY_FLAG}: true`,
    );
  }
  if (
    JSON.stringify(inspection.exports) !==
    JSON.stringify([...EVAL_NAPI_EXPORTS].sort())
  ) {
    violations.push(
      `the evaluation .node must export exactly ${JSON.stringify(EVAL_NAPI_EXPORTS)} (found ${JSON.stringify(inspection.exports)})`,
    );
  }
  for (const violation of scanNativeBinary(binary, "eval"))
    violations.push(violation.message);
  if (defaultNodeBefore !== defaultNodeAfter) {
    violations.push("the default .node changed during the evaluation build");
  }
  if (declarationsBefore !== declarationsAfter) {
    violations.push(
      "the tracked index.d.ts changed during the evaluation build",
    );
  }
  return violations;
}

/** The source identity of the candidate: clean, its HEAD, base and tree, its file hashes. */
async function sourceIdentity(root) {
  const status = cleanStatus(root);
  const candidate = {
    ...captureCandidate(root),
    worktreeClean: status.length === 0,
  };
  const paths = sourcePaths(root, candidate.resolvedHeadSha);
  return { candidate, paths, digests: await sourceDigests(root, paths) };
}

function commandRecord(entry, result) {
  return {
    id: entry.id,
    argv: [entry.command, ...entry.args],
    status: commandStatus(result),
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    closeObserved: result?.closeObserved ?? null,
    termination: result?.termination ?? null,
    cleanup: { complete: result?.cleanup?.complete === true },
  };
}

/**
 * Builds the evaluation `.node` and the worker on a clean candidate and writes
 * `eval-build.json` in the shape the Graph arm's guard reads
 * (`assertEvalBuildReceipt` in `scripts/quality/nir1-retrieval/contract.mjs`).
 * The candidate is resolved and compared before and after the build with the
 * standard build's own functions (`standard-build.mjs`); any difference, a
 * failed command or a failed check leaves no manifest. A manifest of an
 * earlier run is removed first.
 */
export async function runEvalNativeBuild({
  root: requestedRoot,
  outDir = DEFAULT_OUT_DIR,
  runCommand = runLocalCiCommand,
  inspect = inspectEvalModule,
}) {
  const root = await realpath(requestedRoot);
  const plan = planEvalNativeBuild({ root, outDir });
  const startedAt = new Date().toISOString();
  await mkdir(plan.out, { recursive: true });
  await rm(plan.outputs.manifest, { force: true });
  const before = await sourceIdentity(root);
  if (!before.candidate.worktreeClean) {
    throw precheck(
      "the evaluation build needs a clean candidate worktree; no manifest was written",
    );
  }
  const defaultNodeBefore = await optionalSha256(path.join(root, DEFAULT_NODE));
  const declarationsBefore = await optionalSha256(
    path.join(root, TRACKED_DECLARATIONS),
  );
  const commands = [];
  for (const entry of plan.commands) {
    const result = await runCommand(
      { command: entry.command, args: [...entry.args], cwd: entry.cwd },
      {
        root,
        logDirectory: path.relative(root, plan.out),
        taskId: entry.id,
        timeoutMs: COMMAND_TIMEOUT_MS,
        termGraceMs: GRACE_MS,
        killGraceMs: GRACE_MS,
        closeGraceMs: GRACE_MS,
      },
    );
    const record = commandRecord(entry, result);
    commands.push(record);
    if (record.status !== "passed") {
      throw new Error(
        `the ${entry.id} build ${record.status}; no manifest was written`,
      );
    }
  }
  for (const copy of plan.copies) {
    await stat(copy.from);
    await copyFile(copy.from, copy.to);
  }
  const after = await sourceIdentity(root);
  const sourceUnchanged =
    after.candidate.worktreeClean &&
    sameCandidate(before.candidate, after.candidate) &&
    isDeepStrictEqual(before.paths, after.paths) &&
    isDeepStrictEqual(before.digests, after.digests);
  if (!sourceUnchanged) {
    throw precheck(
      "the candidate changed during the evaluation build (dirty, HEAD, base, tree or file hashes); no manifest was written",
    );
  }
  const binary = await readFile(plan.outputs.node);
  const inspection = inspect(plan.outputs.node);
  const violations = verifyEvalBuild({
    inspection,
    binary,
    defaultNodeBefore,
    defaultNodeAfter: await optionalSha256(path.join(root, DEFAULT_NODE)),
    declarationsBefore,
    declarationsAfter: await optionalSha256(
      path.join(root, TRACKED_DECLARATIONS),
    ),
  });
  if (violations.length > 0) {
    throw new Error(
      `the evaluation build failed its checks; no manifest was written:\n${violations.join("\n")}`,
    );
  }
  const nodePath = path.relative(root, plan.outputs.node);
  const workerPath = path.relative(root, plan.outputs.worker);
  const workerSha256 = await sha256File(plan.outputs.worker);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    status: "passed",
    standardBuild: false,
    evaluationBuild: true,
    sourceUnchanged: true,
    root,
    candidate: before.candidate,
    features: plan.features,
    capabilities: inspection.capabilities,
    exports: inspection.exports,
    artifacts: {
      [nodePath]: createHash("sha256").update(binary).digest("hex"),
      [workerPath]: workerSha256,
    },
    worker: { path: workerPath, sha256: workerSha256 },
    declarations: {
      path: path.relative(root, plan.outputs.declarations),
      sha256: await sha256File(plan.outputs.declarations),
    },
    commands,
    defaultNodeUnchanged: { path: DEFAULT_NODE, sha256: defaultNodeBefore },
    distributed: false,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(
    plan.outputs.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out");
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  runEvalNativeBuild({
    root,
    outDir: at === -1 ? DEFAULT_OUT_DIR : argv[at + 1],
  }).then(
    (manifest) => console.log(JSON.stringify(manifest, null, 2)),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
