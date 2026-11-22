/**
 * モデル能力の写しの保管（PR-C2）：同梱の写しの読込みと、取得した写しの cache（1 file）。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §3.3（T9）・§4.4 と §7。
 *
 * 読むときは毎回 `parseSnapshot` を通す（保存済みでも未検証として扱う）。cache は同梱の写しと
 * `compareSnapshots` で比べ、同梱より古い・急減している cache は採用しない。
 * cache は app の data 領域（userData）の 1 file で、tmp＋rename で書く（`keyStore.ts` の前例）。
 * workspace の DB には入れない。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  compareSnapshots,
  parseSnapshot,
  SNAPSHOT_POLICY,
  type Snapshot,
  type SnapshotFailureCode,
  type SnapshotPolicy,
} from "../shared/modelCapabilityRegistry.js";
import {
  MODEL_CAPABILITY_FETCH_HOST,
  MODEL_CAPABILITY_SNAPSHOT_REPO_PATH,
} from "./modelCapabilityFetch.js";
import { removeOwnTemporaryFiles } from "./ownTemporaryFiles.js";

/** cache の file 名（userData の直下）。 */
export const MODEL_CAPABILITY_CACHE_FILE = "model-capabilities-cache.json";
/** 同梱の写しの file 名。packaged では resources/model-capabilities/ に置く（electron-builder の extraResources）。 */
export const MODEL_CAPABILITY_BUNDLED_FILE = path.posix.basename(
  MODEL_CAPABILITY_SNAPSHOT_REPO_PATH,
);

/** 採用してよい写しの取得元の刻印。GitHub の写しは "grimodex" だけ（"models.dev" は直接取得の選択肢が出るまで拒否。T8）。 */
export const MODEL_CAPABILITY_ACCEPTED_SOURCE = "grimodex";

const CACHE_SCHEMA_VERSION = 1;
/** cache の envelope（本文を JSON の文字列として持つ）の上限。本文の上限の 4 倍（引用符の escape の余裕）。2026-11-19 に確定。 */
const CACHE_FILE_MAX_FACTOR = 4;

export interface ModelCapabilityCacheEnvelope {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  /** 取得した時刻（ISO 8601 の UTC）。写しの `generatedAt` とは別。 */
  readonly fetchedAt: string;
  /** 取得元の host（取得先の切替で別の cache を混ぜない。Q14）。 */
  readonly fetchedFrom: string;
  /** 取得した本文（bytes）の SHA-256（小文字の hex）。破損・手編集の検出用。 */
  readonly bodySha256: string;
  /** 取得した本文（検証を通ったもの）。 */
  readonly body: string;
}

export type BundledSnapshotResult =
  | {
      readonly ok: true;
      readonly snapshot: Snapshot;
      readonly digest: string;
    }
  | { readonly ok: false; readonly reason: BundledFailureReason };
export type BundledFailureReason =
  | "unreadable"
  | `invalid:${SnapshotFailureCode}`
  | "source";

export type CacheSnapshotResult =
  | {
      readonly ok: true;
      readonly snapshot: Snapshot;
      readonly digest: string;
      readonly fetchedAt: string;
    }
  | { readonly ok: false; readonly reason: CacheFailureReason };
export type CacheFailureReason =
  | "absent"
  | "unreadable"
  | "too-large"
  | "envelope"
  | "origin"
  | "digest"
  | `invalid:${SnapshotFailureCode}`
  | "source"
  | "no-baseline"
  | `rejected:${SnapshotFailureCode}`;

export interface ModelCapabilityStoreOptions {
  /** cache を置く directory（userData）。 */
  readonly cacheDir: string;
  /** 同梱の写しの file の絶対 path。 */
  readonly bundledPath: string;
  readonly policy?: SnapshotPolicy;
}

export interface ModelCapabilityStore {
  /** 同梱の写しを読み、検証する。file の text は 1 回だけ読んで持つ。 */
  loadBundled(nowMs: number): BundledSnapshotResult;
  /**
   * cache を読み、検証し、同梱の写しと比べる（同梱が読めないときは採用しない）。
   * 失敗の理由は code で返し、壊れた cache（digest・形・検証の失敗）は削除する。
   */
  readCache(nowMs: number): CacheSnapshotResult;
  /**
   * cache を書く。rename の直前に `guard()` を同期で呼び、false なら書かない（世代の交代・設定の
   * 無効化・profile の閉鎖の後に書かないため）。guard と rename の間に await は無い。
   * 書いたら true。
   */
  writeCache(body: string, fetchedAtMs: number, guard: () => boolean): boolean;
  /** cache と tmp の残骸を削除する（設定の無効化。Q4）。失敗は投げない。 */
  purgeCache(): void;
  /**
   * crash・kill で残った自分の tmp（`<cache file>.<pid>.<uuid>.tmp` に完全一致するもの）だけを消す。
   * 起動時（書込みの前）に呼ぶ。cache 本体と他の file には触れない。消した件数を返す。
   */
  removeStaleTemporaryFiles(): number;
}

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readBoundedUtf8(filePath: string, maxBytes: number): string {
  const stats = statSync(filePath);
  if (!stats.isFile()) throw new Error("not-file");
  if (stats.size > maxBytes) throw new TooLargeError();
  const bytes = readFileSync(filePath);
  if (bytes.byteLength > maxBytes) throw new TooLargeError();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

class TooLargeError extends Error {
  constructor() {
    super("too-large");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function createModelCapabilityStore(
  options: ModelCapabilityStoreOptions,
): ModelCapabilityStore {
  const policy = options.policy ?? SNAPSHOT_POLICY;
  const cachePath = path.join(options.cacheDir, MODEL_CAPABILITY_CACHE_FILE);
  const maxCacheBytes = policy.maxSnapshotBytes * CACHE_FILE_MAX_FACTOR;
  let bundledText: string | null = null;

  function loadBundled(nowMs: number): BundledSnapshotResult {
    if (bundledText === null) {
      try {
        bundledText = readBoundedUtf8(
          options.bundledPath,
          policy.maxSnapshotBytes,
        );
      } catch {
        return { ok: false, reason: "unreadable" };
      }
    }
    const parsed = parseSnapshot(bundledText, policy, { nowMs });
    if (!parsed.ok) return { ok: false, reason: `invalid:${parsed.code}` };
    if (parsed.snapshot.source !== MODEL_CAPABILITY_ACCEPTED_SOURCE) {
      return { ok: false, reason: "source" };
    }
    return { ok: true, snapshot: parsed.snapshot, digest: parsed.digest };
  }

  function removeCacheFile(): void {
    try {
      rmSync(cachePath, { force: true });
    } catch {
      // 削除できなくても、次回の読込みが同じ理由で棄却する。
    }
  }

  function readCache(nowMs: number): CacheSnapshotResult {
    let text: string;
    try {
      text = readBoundedUtf8(cachePath, maxCacheBytes);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "absent" };
      }
      if (error instanceof TooLargeError) {
        removeCacheFile();
        return { ok: false, reason: "too-large" };
      }
      return { ok: false, reason: "unreadable" };
    }
    const envelope = parseEnvelope(text);
    if (envelope === null) {
      removeCacheFile();
      return { ok: false, reason: "envelope" };
    }
    if (envelope.fetchedFrom !== MODEL_CAPABILITY_FETCH_HOST) {
      // 取得元が違う cache は混ぜない（Q14）。
      removeCacheFile();
      return { ok: false, reason: "origin" };
    }
    if (sha256OfText(envelope.body) !== envelope.bodySha256) {
      removeCacheFile();
      return { ok: false, reason: "digest" };
    }
    const parsed = parseSnapshot(envelope.body, policy, { nowMs });
    if (!parsed.ok) {
      removeCacheFile();
      return { ok: false, reason: `invalid:${parsed.code}` };
    }
    if (parsed.snapshot.source !== MODEL_CAPABILITY_ACCEPTED_SOURCE) {
      removeCacheFile();
      return { ok: false, reason: "source" };
    }
    const bundled = loadBundled(nowMs);
    // 同梱が読めない間は、cache に比べる基準が無い。採用せず、cache は消さない（同梱が直れば使える）。
    if (!bundled.ok) return { ok: false, reason: "no-baseline" };
    const compared = compareSnapshots(
      bundled.snapshot,
      parsed.snapshot,
      policy,
    );
    if (!compared.ok) {
      // 同梱より古い・急減した cache は、app の更新で同梱が進んだときに起きる。使わず、消す。
      removeCacheFile();
      return { ok: false, reason: `rejected:${compared.code}` };
    }
    return {
      ok: true,
      snapshot: parsed.snapshot,
      digest: parsed.digest,
      fetchedAt: envelope.fetchedAt,
    };
  }

  function writeCache(
    body: string,
    fetchedAtMs: number,
    guard: () => boolean,
  ): boolean {
    const envelope: ModelCapabilityCacheEnvelope = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      fetchedFrom: MODEL_CAPABILITY_FETCH_HOST,
      bodySha256: sha256OfText(body),
      body,
    };
    const serialized = JSON.stringify(envelope);
    mkdirSync(options.cacheDir, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(tmp, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      // guard と rename の間に await は無い（JS の単一 thread なので、他の処理は割り込めない）。
      if (!guard()) return false;
      renameSync(tmp, cachePath);
      return true;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(tmp, { force: true });
    }
  }

  function purgeCache(): void {
    removeCacheFile();
    removeOwnTemporaryFiles(options.cacheDir, MODEL_CAPABILITY_CACHE_FILE);
  }

  function removeStaleTemporaryFiles(): number {
    return removeOwnTemporaryFiles(
      options.cacheDir,
      MODEL_CAPABILITY_CACHE_FILE,
    );
  }

  return {
    loadBundled,
    readCache,
    writeCache,
    purgeCache,
    removeStaleTemporaryFiles,
  };
}

function parseEnvelope(text: string): ModelCapabilityCacheEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "body,bodySha256,fetchedAt,fetchedFrom,schemaVersion"
  ) {
    return null;
  }
  if (record.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (!isIsoUtc(record.fetchedAt)) return null;
  if (
    typeof record.fetchedFrom !== "string" ||
    typeof record.bodySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.bodySha256) ||
    typeof record.body !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fetchedAt: record.fetchedAt,
    fetchedFrom: record.fetchedFrom,
    bodySha256: record.bodySha256,
    body: record.body,
  };
}
