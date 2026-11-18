/**
 * 「モデル情報の自動更新」の設定（Q4。既定は有効）。AI 設定の 1 項目として renderer に見せるが、
 * 保存は main が持つ。
 *
 * 保存を main に置く理由：共有 Rust の `grimodex_ai::AiSettings` は型付きの struct で、struct に無い key は
 * `save_ai_settings` の往復で捨てられる（`reasoning_effort_override` の注記を参照）。TS の型だけに足すと、
 * 利用者が無効にしても再起動で既定（有効）へ戻り、承認と逆の通信が起きる。そこで、backend の
 * `saveAiSettings`／`getAiSettings` を main で包み、この項目だけを main の 1 file に保存して、読み出しの
 * ときに AiSettings の JSON へ戻す。renderer から見ると、他の項目と同じ AiSettings の往復になる。
 *
 * 規則：
 *   - 項目が無い save（既定値から作った設定など）は、現在の値を変えない。boolean のときだけ更新する。
 *   - file が無ければ有効。読めない・壊れているときは無効（fail-closed。本人の意思が分からないまま通信しない）。
 *   - 書けなければ save を失敗させ、メモリの値も変えない。
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

import type { NapiBackendLike } from "../shared/ipcContract.js";

/** AiSettings の JSON に載せる項目名。 */
export const MODEL_INFO_AUTO_UPDATE_KEY = "modelInfoAutoUpdate";
export const MODEL_INFO_SETTING_FILE = "model-info-settings.json";

const SETTING_SCHEMA_VERSION = 1;

export interface ModelInfoSetting {
  get(): boolean;
  /** 値を保存する。変わったときだけ listener を呼ぶ。書けなければ投げる（値は変えない）。 */
  set(value: boolean): void;
  onChange(listener: () => void): () => void;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function createModelInfoSetting(
  userDataDir: string,
  warn: (message: string) => void = (message) => console.warn(message),
): ModelInfoSetting {
  const filePath = path.join(userDataDir, MODEL_INFO_SETTING_FILE);
  const listeners = new Set<() => void>();
  let current = true;

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(",") ===
        `${MODEL_INFO_AUTO_UPDATE_KEY},schemaVersion` &&
      (parsed as Record<string, unknown>).schemaVersion ===
        SETTING_SCHEMA_VERSION &&
      typeof (parsed as Record<string, unknown>)[MODEL_INFO_AUTO_UPDATE_KEY] ===
        "boolean"
    ) {
      current = (parsed as Record<string, unknown>)[
        MODEL_INFO_AUTO_UPDATE_KEY
      ] as boolean;
    } else {
      current = false;
      warn("[model-capability] setting file is invalid; auto update is off");
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      current = false;
      warn("[model-capability] setting file is unreadable; auto update is off");
    }
  }

  function persist(value: boolean): void {
    mkdirSync(userDataDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(tmp, "wx", 0o600);
      writeFileSync(
        descriptor,
        JSON.stringify({
          schemaVersion: SETTING_SCHEMA_VERSION,
          [MODEL_INFO_AUTO_UPDATE_KEY]: value,
        }),
        "utf8",
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(tmp, filePath);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(tmp, { force: true });
    }
  }

  return {
    get: () => current,
    set(value) {
      if (value === current) return;
      persist(value);
      current = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // listener の失敗で、保存した設定の往復を失敗させない。
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * backend の `getAiSettings`／`saveAiSettings` を包み、「モデル情報の自動更新」を AiSettings の往復に
 * 載せる。他の method はそのまま通す。backend が null なら null のまま。
 */
export function wrapBackendForModelInfoSetting(
  backend: NapiBackendLike | null,
  setting: ModelInfoSetting,
): NapiBackendLike | null {
  if (!backend) return backend;
  const overrides: Partial<NapiBackendLike> = {
    async getAiSettings(): Promise<string> {
      const raw = await backend.getAiSettings();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return raw;
      }
      if (!isPlainRecord(parsed)) return raw;
      return JSON.stringify({
        ...parsed,
        [MODEL_INFO_AUTO_UPDATE_KEY]: setting.get(),
      });
    },
  };
  if (typeof backend.saveAiSettings === "function") {
    overrides.saveAiSettings = async (settings: unknown): Promise<void> => {
      let forNative = settings;
      let requested: boolean | undefined;
      if (isPlainRecord(settings) && MODEL_INFO_AUTO_UPDATE_KEY in settings) {
        const { [MODEL_INFO_AUTO_UPDATE_KEY]: value, ...rest } = settings;
        if (typeof value === "boolean") requested = value;
        forNative = rest;
      }
      // Native の保存が成功してから、この項目を保存する（Native が拒否した保存では何も変えない）。
      await backend.saveAiSettings?.(forNative);
      if (requested !== undefined) setting.set(requested);
    };
  }
  return new Proxy(backend, {
    get(target, property) {
      const override = Reflect.get(overrides, property);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
