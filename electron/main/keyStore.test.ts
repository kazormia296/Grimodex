/**
 * keyStore（safeStorage ベースの API キー保管）の単体テスト（Phase 3 バッチ3a）。
 * node 環境。safeStorage は fake を注入して暗号化/永続化・fallback・削除の対称性を検証する。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildKeyStoreShellHandlers,
  createKeyStore,
  type SafeStorageLike,
} from "./keyStore.js";

/** 可逆な fake safeStorage（"enc:" プレフィックスの平文格納）。available は可変。 */
function fakeStorage(
  available = true,
  backend: ReturnType<
    SafeStorageLike["getSelectedStorageBackend"]
  > = "gnome_libsecret",
): SafeStorageLike & { available: boolean; backend: string } {
  return {
    available,
    backend,
    isEncryptionAvailable() {
      return this.available;
    },
    getSelectedStorageBackend() {
      return this.backend as ReturnType<
        SafeStorageLike["getSelectedStorageBackend"]
      >;
    },
    encryptString(plain: string) {
      return Buffer.from(`enc:${plain}`, "utf8");
    },
    decryptString(buf: Buffer) {
      const s = buf.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("bad ciphertext");
      return s.slice(4);
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "grimodex-keystore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createKeyStore", () => {
  it("save → has(true) → resolve でキーを解決する", () => {
    const ks = createKeyStore(dir, fakeStorage());
    expect(ks.hasApiKey("openai", null)).toBe(false);
    ks.saveApiKey("openai", null, "sk-openai");
    expect(ks.hasApiKey("openai", null)).toBe(true);
    const settings = { provider: "openai" };
    expect(ks.resolveApiKeyForRequest(settings, undefined, undefined)).toBe(
      "sk-openai",
    );
  });

  it("暗号文は ai-keys.json に nested で永続化され、別インスタンスから読める", () => {
    createKeyStore(dir, fakeStorage()).saveApiKey("anthropic", null, "sk-a");
    const file = path.join(dir, "ai-keys.json");
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, string>
    >;
    // service / account 命名で格納（Tauri 互換）。平文ではない。
    expect(stored["grimodex-anthropic"]["grimodex-user"]).toBe(
      Buffer.from("enc:sk-a", "utf8").toString("base64"),
    );
    // 新インスタンス（ファイル正本）で読める。
    const ks2 = createKeyStore(dir, fakeStorage());
    expect(ks2.hasApiKey("anthropic", null)).toBe(true);
  });

  it("delete は legacy 候補も含めて全消しする（default→grimodex-user 対称）", () => {
    const ks = createKeyStore(dir, fakeStorage());
    // "default" と legacy(grimodex-user) の両方にキーがある状態を作る。
    ks.saveApiKey("openai-compatible", "default", "sk-default");
    ks.saveApiKey("openai-compatible", null, "sk-legacy"); // account=grimodex-user
    expect(ks.hasApiKey("openai-compatible", "default")).toBe(true);
    ks.deleteApiKey("openai-compatible", "default");
    // 両候補が消え、has は false（無反応バグの回帰ガード）。
    expect(ks.hasApiKey("openai-compatible", "default")).toBe(false);
  });

  it("OpenAI 互換の endpoint 別キーは独立、未設定は空文字（任意）", () => {
    const ks = createKeyStore(dir, fakeStorage());
    ks.saveApiKey("openai-compatible", "ep1", "sk-ep1");
    const settings = {
      provider: "openai-compatible",
      openaiCompatibleEndpoints: [{ id: "ep1" }, { id: "ep2" }],
      activeOpenaiCompatibleEndpointId: "ep1",
    };
    expect(ks.resolveApiKeyForRequest(settings, undefined, undefined)).toBe(
      "sk-ep1",
    );
    // active を ep2 へ（未設定）→ 任意なので空文字。
    const settings2 = { ...settings, activeOpenaiCompatibleEndpointId: "ep2" };
    expect(ks.resolveApiKeyForRequest(settings2, undefined, undefined)).toBe(
      "",
    );
  });

  it("必須プロバイダのキー未設定は resolve が throw する", () => {
    const ks = createKeyStore(dir, fakeStorage());
    expect(() =>
      ks.resolveApiKeyForRequest(
        { provider: "anthropic" },
        undefined,
        undefined,
      ),
    ).toThrow("No API key configured for anthropic");
  });

  it("暗号化が利用不可なら save は明示エラー", () => {
    const ks = createKeyStore(dir, fakeStorage(false));
    expect(() => ks.saveApiKey("openai", null, "sk")).toThrow(
      /セキュアストレージが利用できない/,
    );
  });

  it("Linux の basic_text / unknown backend ではキーを保存しない", () => {
    for (const backend of ["basic_text", "unknown"] as const) {
      const ks = createKeyStore(dir, fakeStorage(true, backend), "linux");
      expect(() => ks.saveApiKey("openai", null, "sk")).toThrow(
        /安全な OS パスワードストア/,
      );
    }
  });

  it("復号失敗は伝播し、legacy キーへ無言フォールバックしない", () => {
    const storage = fakeStorage();
    const ks = createKeyStore(dir, storage);
    ks.saveApiKey("openai-compatible", "default", "sk-primary");
    ks.saveApiKey("openai-compatible", null, "sk-legacy");
    storage.decryptString = () => {
      throw new Error("decrypt failed");
    };
    expect(() =>
      ks.resolveApiKeyForRequest(
        {
          provider: "openai-compatible",
          openaiCompatibleEndpoints: [{ id: "default" }],
          activeOpenaiCompatibleEndpointId: "default",
        },
        undefined,
        undefined,
      ),
    ).toThrow("保存済み API キーを復号できません");
  });

  it("破損ファイルへの save は失敗し、元ファイルを上書きしない", () => {
    const file = path.join(dir, "ai-keys.json");
    const corrupt = '{"grimodex-openai":';
    writeFileSync(file, corrupt, "utf8");
    const ks = createKeyStore(dir, fakeStorage());
    expect(() => ks.saveApiKey("anthropic", null, "sk-new")).toThrow(
      /API キーストアが破損/,
    );
    expect(readFileSync(file, "utf8")).toBe(corrupt);
  });

  it("nested schema が不正なファイルも空ストア扱いにしない", () => {
    const file = path.join(dir, "ai-keys.json");
    const malformed = JSON.stringify({ "grimodex-openai": "not-a-bucket" });
    writeFileSync(file, malformed, "utf8");
    const ks = createKeyStore(dir, fakeStorage());
    expect(() => ks.hasApiKey("openai", null)).toThrow(/形式が不正/);
    expect(readFileSync(file, "utf8")).toBe(malformed);
  });
});

describe("buildKeyStoreShellHandlers", () => {
  it("has/save/delete を keyStore へ委譲する", async () => {
    const ks = createKeyStore(dir, fakeStorage());
    const handlers = buildKeyStoreShellHandlers(ks);
    expect(await handlers.save_api_key({ provider: "openai", key: "sk" })).toBe(
      null,
    );
    expect(await handlers.has_api_key({ provider: "openai" })).toBe(true);
    expect(await handlers.delete_api_key({ provider: "openai" })).toBe(null);
    expect(await handlers.has_api_key({ provider: "openai" })).toBe(false);
  });

  it("必須文字列と endpointId の型違いを空文字/null に丸めず reject する", async () => {
    const handlers = buildKeyStoreShellHandlers(
      createKeyStore(dir, fakeStorage()),
    );
    await expect(
      handlers.save_api_key({ provider: "openai", key: 123 }),
    ).rejects.toThrow(/`key`.*expected a string/);
    await expect(
      handlers.delete_api_key({ provider: "openai", endpointId: 42 }),
    ).rejects.toThrow(/`endpointId`.*expected a string or null/);
    await expect(handlers.has_api_key({})).rejects.toThrow(
      /`provider`.*expected a string/,
    );
  });
});
