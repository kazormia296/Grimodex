/**
 * Mastra を load するときに当てる env の固定（Mastra 移行 MP-1、脅威モデル D1／T1／T10、U-5）。
 *
 * まだ main のどこからも呼ばない。MP-3 で、旗が開いて Mastra を最初に load する直前に 1 回だけ
 * `apply()` を呼ぶ。旗が閉じているあいだ（製品の launch の既定）は何も変えない。
 *
 * - 固定する値：`MASTRA_TELEMETRY_DISABLED` は厳密に `"1"`（`0`・`disabled`・空文字は無効化にならない）、
 *   `MASTRA_OFFLINE` は `"true"`。
 * - 除く env：`MASTRA_*` の全部（`MASTRA_DEV`・`MASTRA_AUTO_REFRESH_PROVIDERS`・license 系を含む）、
 *   `OM_DEBUG`（cwd の `om-debug.log` への書込み）、`OM_REPRO_CAPTURE`・`OM_REPRO_CAPTURE_DIR`
 *   （会話の再現 file の書込み）、`VERCEL_OIDC_TOKEN`、memory が attachment の token 数を POST する
 *   3 社の API key（M13(a)）。利用者の shell の env は Electron に継承されるので、ここで落とす。
 * - 子 process（`cliAi`／`codexAppServer`）は `process.env` から env を組む。固定を当てた後の
 *   `process.env` を渡すと旗が閉じていても挙動が変わるので、元の env の写しを `originalEnv()` で渡す。
 *   写しを渡す配線は MP-3 で行う（この MP では配線しない）。
 *
 * このファイルは `@mastra/*` を import しない。
 */

/** 固定する env（値は厳密にこの文字列）。 */
export const MASTRA_PINNED_ENV = Object.freeze({
  MASTRA_TELEMETRY_DISABLED: "1",
  MASTRA_OFFLINE: "true",
} as const);

/** 名前の先頭がこれなら除く（`MASTRA_*` の全部）。 */
export const MASTRA_REMOVED_ENV_PREFIXES: readonly string[] = Object.freeze([
  "MASTRA_",
]);

/**
 * 名前が一致したら除く env。
 * `GOOGLE_*` は memory の attachment の計数が引く 2 つ、API key は M13(a) の 3 社。
 */
export const MASTRA_REMOVED_ENV_NAMES: readonly string[] = Object.freeze([
  "OM_DEBUG",
  "OM_REPRO_CAPTURE",
  "OM_REPRO_CAPTURE_DIR",
  "VERCEL_OIDC_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
]);

/** Windows の env 名は大文字小文字を区別しないので、plain object でも大文字に揃えて比べる。 */
function fold(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

/** この名前の env を除くか。 */
export function isMastraRemovedEnvName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const key = fold(name, platform);
  return (
    MASTRA_REMOVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    MASTRA_REMOVED_ENV_NAMES.some((removed) => key === removed)
  );
}

/** `apply()` の結果。値は含めない（secret を記録に残さない）。 */
export interface MastraEnvPinResult {
  /** 除いた env の名前（昇順）。 */
  readonly removed: readonly string[];
  /** 固定した env の名前と値。 */
  readonly pinned: Readonly<Record<string, string>>;
}

export interface MastraEnvPin {
  /**
   * Mastra を load する直前に呼ぶ。除く env を消し、固定する値を置く。
   * 冪等：2 回目以降は env に触れず、最初の結果を返す（固定済みの env を「元の env」として撮り直さない）。
   */
  apply(): MastraEnvPinResult;
  /**
   * 固定を当てる前の env の写し（子 process に渡す用）。呼ぶたびに新しい object を返す。
   * `apply()` の前は現在の env の写し。
   */
  originalEnv(): NodeJS.ProcessEnv;
  /** `apply()` が呼ばれたか。 */
  readonly applied: boolean;
}

export interface CreateMastraEnvPinOptions {
  /** 対象の env。既定は `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export function createMastraEnvPin(
  options: CreateMastraEnvPinOptions = {},
): MastraEnvPin {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let snapshot: Readonly<NodeJS.ProcessEnv> | undefined;
  let result: MastraEnvPinResult | undefined;

  return {
    apply(): MastraEnvPinResult {
      if (result) return result;
      snapshot = Object.freeze({ ...env });
      const removed: string[] = [];
      for (const name of Object.keys(env)) {
        if (isMastraRemovedEnvName(name, platform)) {
          delete env[name];
          removed.push(name);
        }
      }
      for (const [name, value] of Object.entries(MASTRA_PINNED_ENV)) {
        env[name] = value;
      }
      result = Object.freeze({
        removed: Object.freeze(removed.sort()),
        pinned: MASTRA_PINNED_ENV,
      });
      return result;
    },
    originalEnv(): NodeJS.ProcessEnv {
      return { ...(snapshot ?? env) };
    },
    get applied(): boolean {
      return result !== undefined;
    },
  };
}
