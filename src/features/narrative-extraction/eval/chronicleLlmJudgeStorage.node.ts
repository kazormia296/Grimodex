import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  serializeChronicleLlmJudgeOfflineResult,
  type ChronicleLlmJudgeOfflineResult,
  type ChronicleLlmJudgePreparedRun,
} from "./chronicleLlmJudgeOffline";
import { sha256Digest } from "../source/digest";
import type { Sha256Digest } from "../source/types";

export const DIAGNOSTIC_FILE_NAME = "diagnostic.json";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type ChronicleLlmJudgeDiagnosticStorageErrorCode =
  | "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED"
  | "JUDGE_DIAGNOSTIC_OUTPUT_ROOT_INVALID"
  | "JUDGE_DIAGNOSTIC_RUN_ID_INVALID"
  | "JUDGE_DIAGNOSTIC_DESTINATION_EXISTS"
  | "JUDGE_DIAGNOSTIC_WRITE_FAILED";

export class ChronicleLlmJudgeDiagnosticStorageError extends Error {
  readonly code: ChronicleLlmJudgeDiagnosticStorageErrorCode;

  constructor(
    code: ChronicleLlmJudgeDiagnosticStorageErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChronicleLlmJudgeDiagnosticStorageError";
    this.code = code;
  }
}

export interface SaveChronicleLlmJudgeOfflineDiagnosticInput {
  readonly run: ChronicleLlmJudgePreparedRun;
  readonly result: ChronicleLlmJudgeOfflineResult;
  /** Existing directory owned by the trusted caller. It is never created. */
  readonly outputRoot: string;
  /** Test-only trusted seam for deterministic destination collision checks. */
  readonly createRunId?: () => string;
}

export interface SavedChronicleLlmJudgeOfflineDiagnostic {
  readonly runId: string;
  readonly runDir: string;
  readonly diagnosticPath: string;
  readonly diagnosticDigest: Sha256Digest;
  readonly byteLength: number;
}

/**
 * The prepared run owns the context-authenticated serializer. Keeping this
 * call in one small boundary means raw input and original-ID maps cannot enter
 * the filesystem sink through a caller supplied duck-typed run.
 */
async function serializeSanitizedResult(
  run: ChronicleLlmJudgePreparedRun,
  result: ChronicleLlmJudgeOfflineResult,
): Promise<{ readonly text: string; readonly digest: Sha256Digest }> {
  let text: string;
  try {
    text = await serializeChronicleLlmJudgeOfflineResult(run, result);
  } catch (cause) {
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED",
      "Prepared run refused to serialize this result",
      { cause },
    );
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED",
      "Prepared run returned an empty diagnostic serialization",
    );
  }
  try {
    return { text, digest: await sha256Digest(text) };
  } catch (cause) {
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED",
      "Diagnostic serialization could not be digested",
      { cause },
    );
  }
}

/** Reject symlinked components so a trusted root remains the write boundary. */
async function assertTrustedOutputRoot(outputRoot: string): Promise<string> {
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) {
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_OUTPUT_ROOT_INVALID",
      "Diagnostic output root must be an absolute existing directory",
    );
  }
  const resolved = path.resolve(outputRoot);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    let entry;
    try {
      entry = await lstat(current);
    } catch (cause) {
      throw new ChronicleLlmJudgeDiagnosticStorageError(
        "JUDGE_DIAGNOSTIC_OUTPUT_ROOT_INVALID",
        "Diagnostic output root must already exist",
        { cause },
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ChronicleLlmJudgeDiagnosticStorageError(
        "JUDGE_DIAGNOSTIC_OUTPUT_ROOT_INVALID",
        "Diagnostic output root cannot contain a symlink and must be a directory",
      );
    }
  }
  return resolved;
}

function nextRunId(createRunId?: () => string): string {
  let value: string;
  try {
    value = (createRunId ?? randomUUID)();
  } catch (cause) {
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_RUN_ID_INVALID",
      "Run ID generation failed",
      { cause },
    );
  }
  if (!RUN_ID_PATTERN.test(value)) {
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_RUN_ID_INVALID",
      "Run ID contains path or unsafe characters",
    );
  }
  return value;
}

async function cleanupOwnedRun(
  runDir: string,
  diagnosticPath: string,
): Promise<void> {
  await unlink(diagnosticPath).catch(() => undefined);
  await rmdir(runDir).catch(() => undefined);
}

/**
 * Save one sealed diagnostic under a fresh exclusive run directory. The
 * authenticated serializer and digest complete before any filesystem write.
 */
export async function saveChronicleLlmJudgeOfflineDiagnostic({
  run,
  result,
  outputRoot,
  createRunId,
}: SaveChronicleLlmJudgeOfflineDiagnosticInput): Promise<SavedChronicleLlmJudgeOfflineDiagnostic> {
  const serialized = await serializeSanitizedResult(run, result);
  const root = await assertTrustedOutputRoot(outputRoot);
  const runId = nextRunId(createRunId);
  const runDir = path.join(root, runId);
  const diagnosticPath = path.join(runDir, DIAGNOSTIC_FILE_NAME);

  let ownsRunDir = false;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      await mkdir(runDir, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ChronicleLlmJudgeDiagnosticStorageError(
          "JUDGE_DIAGNOSTIC_DESTINATION_EXISTS",
          "Refusing to reuse an existing diagnostic run directory",
          { cause },
        );
      }
      throw cause;
    }
    ownsRunDir = true;
    const runStat = await lstat(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw new Error("Fresh diagnostic run directory is not a directory");
    }
    await chmod(runDir, 0o700);

    fileHandle = await open(diagnosticPath, "wx", 0o600);
    await fileHandle.writeFile(serialized.text, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await chmod(diagnosticPath, 0o600);
    const fileStat = await lstat(diagnosticPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error("Diagnostic output is not a regular file");
    }
    return {
      runId,
      runDir,
      diagnosticPath,
      diagnosticDigest: serialized.digest,
      byteLength: Buffer.byteLength(serialized.text, "utf8"),
    };
  } catch (cause) {
    if (fileHandle) await fileHandle.close().catch(() => undefined);
    if (ownsRunDir) await cleanupOwnedRun(runDir, diagnosticPath);
    if (cause instanceof ChronicleLlmJudgeDiagnosticStorageError) throw cause;
    throw new ChronicleLlmJudgeDiagnosticStorageError(
      "JUDGE_DIAGNOSTIC_WRITE_FAILED",
      "Failed to persist diagnostic without changing existing runs",
      { cause },
    );
  }
}
