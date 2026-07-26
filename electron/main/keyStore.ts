/**
 * API キー保管（Electron safeStorage、Phase 3 バッチ3a）。
 *
 * Tauri 版は OS keyring にキーを保存するが、Electron 版は **main プロセスの
 * safeStorage** で暗号化し `<userData>/ai-keys.json` に暗号文を置く。命名規則
 * (service/account) と解決規則は Tauri と完全一致（aiKeyNaming.ts に純関数として
 * 移植済み）。**平文キーは renderer/IPC に出さない** — save は書くだけ、has は bool、
 * 実送信用の解決 (resolveApiKeyForRequest) は main 内で行い napi へ平文を注入する。
 *
 * safeStorage は main プロセス専用 API。テスト容易性のため `SafeStorageLike` を
 * 注入する（index.ts は electron の `safeStorage` を渡す）。暗号文の I/O は tmp+rename
 * で原子的（Tauri の ai-settings.json が非原子だった点を Electron 側で是正）。破損・
 * 読取・復号エラーは fail-closed とし、Linux の弱い basic_text backend は使用しない。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  CommandArgs,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import {
  effectiveProviderEndpoint,
  findApiKey,
  hasApiKey as hasApiKeyRule,
  keyringService,
  keyringUser,
  keyringUserCandidates,
  resolveApiKey as resolveApiKeyRule,
  type AiSettingsLite,
  type KeyLookup,
} from "./aiKeyNaming.js";

/** electron `safeStorage` の必要部分（テストで差し替え可能にするための最小 IF）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend():
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown";
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Plaintext exists only in Electron main during the one-shot migration. */
export interface LegacyApiKeyEntry {
  provider: string;
  endpointId: string | null;
  key: string;
}

export interface LegacyApiKeyImportResult {
  imported: number;
  skippedExisting: number;
}

/** dispatchInvoke / shell ハンドラへ注入する API キーの窓口。 */
export interface SecretsBridge {
  /** キーの有無だけ返す（平文は返さない）。 */
  hasApiKey(provider: string, endpointId: string | null): boolean;
  /** キーを保存（safeStorage 暗号化 → ai-keys.json）。 */
  saveApiKey(provider: string, endpointId: string | null, key: string): void;
  /** キーを削除（legacy 候補も含めて全消し = 削除が無反応に見える非対称バグ防止）。 */
  deleteApiKey(provider: string, endpointId: string | null): void;
  /** チャット送信の実効キーを解決（napi へ注入する平文。空文字許容）。 */
  resolveApiKeyForRequest(
    settings: AiSettingsLite,
    argProvider: unknown,
    argEndpointId: unknown,
  ): string;
  /** モデル一覧用。未登録だけを null にし、復号・ストアエラーは伝播する。 */
  getApiKeyForRequest(
    settings: AiSettingsLite,
    argProvider: unknown,
    argEndpointId: unknown,
  ): string | null;
  /** Main-only atomic import. Existing safeStorage entries always win. */
  importLegacyApiKeys(
    entries: readonly LegacyApiKeyEntry[],
  ): LegacyApiKeyImportResult;
}

/** 暗号文ストア形: `{ [service]: { [account]: base64(safeStorage ciphertext) } }`。 */
type KeyFile = Record<string, Record<string, string>>;

function emptyKeyFile(): KeyFile {
  // OpenAI-compatible endpoint id はユーザー入力であり、"__proto__" 等も文字列として
  // 扱う必要がある。null prototype の辞書にして prototype setter を踏ませない。
  return Object.create(null) as KeyFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON を nested string map へ検証しながら写す（破損時は fail-closed）。 */
function parseKeyFile(raw: string): KeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error("API キーストアが破損しています（JSON を解析できません）", {
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("API キーストアが破損しています（形式が不正です）");
  }

  const store = emptyKeyFile();
  for (const [service, rawBucket] of Object.entries(parsed)) {
    if (!isRecord(rawBucket)) {
      throw new Error("API キーストアが破損しています（形式が不正です）");
    }
    const bucket = Object.create(null) as Record<string, string>;
    for (const [account, cipher] of Object.entries(rawBucket)) {
      if (typeof cipher !== "string") {
        throw new Error("API キーストアが破損しています（形式が不正です）");
      }
      bucket[account] = cipher;
    }
    store[service] = bucket;
  }
  return store;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * safeStorage ベースの API キーストアを作る。
 * @param userDataDir 暗号文ファイル `ai-keys.json` を置くディレクトリ（app.getPath("userData")）
 * @param storage electron の `safeStorage`（テストは fake を注入）
 */
export function createKeyStore(
  userDataDir: string,
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): SecretsBridge {
  const filePath = path.join(userDataDir, "ai-keys.json");

  function load(): KeyFile {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return emptyKeyFile();
      // 一時的な権限エラー等を「空」と誤認して次回 save で全キーを消さない。
      throw new Error("API キーストアを読み込めません", { cause });
    }
    return parseKeyFile(raw);
  }

  function persist(store: KeyFile): void {
    mkdirSync(userDataDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(tmp, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(store, null, 2), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(tmp, filePath);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(tmp, { force: true });
    }
  }

  function requireSecureStorage(): void {
    if (!storage.isEncryptionAvailable()) {
      throw new Error(
        "OS のセキュアストレージが利用できないため API キーを使用できません" +
          "（Electron safeStorage unavailable）",
      );
    }
    if (platform === "linux") {
      const backend = storage.getSelectedStorageBackend();
      if (backend === "basic_text" || backend === "unknown") {
        throw new Error(
          "安全な OS パスワードストアが利用できないため API キーを使用できません" +
            `（Electron safeStorage backend: ${backend}）`,
        );
      }
    }
  }

  // (service, account) → 平文 or null。null は「エントリ無し」だけを表す。
  // 復号失敗は必ず伝播させ、default endpoint の古い legacy キーへ無言で落とさない。
  const getKey: KeyLookup = (service, account) => {
    const b64 = load()[service]?.[account];
    if (typeof b64 !== "string") return null;
    requireSecureStorage();
    try {
      return storage.decryptString(Buffer.from(b64, "base64"));
    } catch (cause) {
      throw new Error("保存済み API キーを復号できません", { cause });
    }
  };

  return {
    hasApiKey(provider, endpointId) {
      return hasApiKeyRule(provider, endpointId, getKey);
    },

    saveApiKey(provider, endpointId, key) {
      const service = keyringService(provider);
      const account = keyringUser(provider, endpointId);
      requireSecureStorage();
      const cipher = storage.encryptString(key).toString("base64");
      const store = load();
      (store[service] ??= Object.create(null) as Record<string, string>)[
        account
      ] = cipher;
      persist(store);
    },

    deleteApiKey(provider, endpointId) {
      const service = keyringService(provider);
      const store = load();
      const bucket = store[service];
      if (!bucket) return;
      let changed = false;
      for (const account of keyringUserCandidates(provider, endpointId)) {
        if (Object.hasOwn(bucket, account)) {
          delete bucket[account];
          changed = true;
        }
      }
      if (Object.keys(bucket).length === 0) {
        delete store[service];
      }
      if (changed) persist(store);
    },

    importLegacyApiKeys(entries) {
      if (entries.length > 512) {
        throw new Error("Legacy API key export exceeds the migration limit");
      }
      requireSecureStorage();
      const store = load();
      const existingAccounts = new Map(
        Object.entries(store).map(([service, bucket]) => [
          service,
          new Set(Object.keys(bucket)),
        ]),
      );
      let imported = 0;
      let skippedExisting = 0;

      // Build the complete encrypted next state in memory. Nothing is written
      // until every encryption and verification succeeds, so a single bad
      // key/backend response cannot leave a partially migrated key file.
      for (const entry of entries) {
        if (
          typeof entry.provider !== "string" ||
          (entry.endpointId !== null && typeof entry.endpointId !== "string") ||
          typeof entry.key !== "string"
        ) {
          throw new Error("Legacy API key export has an invalid shape");
        }
        if (entry.key.length > 64 * 1024) {
          throw new Error("Legacy API key exceeds the migration size limit");
        }

        const endpointId = entry.endpointId || null;
        const service = keyringService(entry.provider);
        const existingBucket = existingAccounts.get(service);
        if (
          existingBucket &&
          keyringUserCandidates(entry.provider, endpointId).some((account) =>
            existingBucket.has(account),
          )
        ) {
          skippedExisting += 1;
          continue;
        }

        const encrypted = storage.encryptString(entry.key);
        let verified: string;
        try {
          verified = storage.decryptString(encrypted);
        } catch (cause) {
          throw new Error("Legacy API key encryption verification failed", {
            cause,
          });
        }
        if (verified !== entry.key) {
          throw new Error("Legacy API key encryption verification mismatch");
        }

        const account = keyringUser(entry.provider, endpointId);
        (store[service] ??= Object.create(null) as Record<string, string>)[
          account
        ] = encrypted.toString("base64");
        imported += 1;
      }

      if (imported > 0) persist(store);
      return { imported, skippedExisting };
    },

    resolveApiKeyForRequest(settings, argProvider, argEndpointId) {
      const { provider, endpointId } = effectiveProviderEndpoint(
        settings,
        argProvider,
        argEndpointId,
      );
      return resolveApiKeyRule(provider, endpointId, getKey);
    },

    getApiKeyForRequest(settings, argProvider, argEndpointId) {
      const { provider, endpointId } = effectiveProviderEndpoint(
        settings,
        argProvider,
        argEndpointId,
      );
      return findApiKey(provider, endpointId, getKey);
    },
  };
}

/** FE 引数の endpointId（未指定/空文字は null = 単一キー）を検証・正規化する。 */
function argEndpointId(args: CommandArgs, cmd: string): string | null {
  const value = args.endpointId;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`endpointId\` for command \`${cmd}\`: expected a string or null`,
    );
  }
  return value;
}

/** Tauri の command deserializer と同じく、必須文字列の欠落・型違いを reject する。 */
function argString(args: CommandArgs, key: string, cmd: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a string`,
    );
  }
  return value;
}

/**
 * has/save/delete_api_key の shell コマンドハンドラを keyStore から組み立てる
 * （ipc ルーターへ extraShellHandlers として注入する）。external_mount と同じく
 * 状態（safeStorage + ai-keys.json）が invoke を跨いで持続するため per-invoke の
 * buildShellCommandHandlers ではなくここで単一インスタンスから作る。
 */
export function buildKeyStoreShellHandlers(
  secrets: SecretsBridge,
): ShellCommandHandlers {
  return {
    has_api_key: async (args) =>
      secrets.hasApiKey(
        argString(args, "provider", "has_api_key"),
        argEndpointId(args, "has_api_key"),
      ),
    save_api_key: async (args) => {
      secrets.saveApiKey(
        argString(args, "provider", "save_api_key"),
        argEndpointId(args, "save_api_key"),
        argString(args, "key", "save_api_key"),
      );
      return null;
    },
    delete_api_key: async (args) => {
      secrets.deleteApiKey(
        argString(args, "provider", "delete_api_key"),
        argEndpointId(args, "delete_api_key"),
      );
      return null;
    },
  };
}
