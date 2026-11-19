/**
 * Mastra を load するときに当てる env の固定（Mastra 移行 MP-1、脅威モデル D1／T1／T10、U-5）。
 *
 * `apply()` はまだ main のどこからも呼ばない（MP-3c が、旗が開いて Mastra を最初に load する直前に 1 回だけ呼ぶ。
 * 静的試験が「`apply` に届くのはこの file だけ」を固定する）。旗が閉じているあいだ（製品の launch の既定）は何も変えない。
 * MP-3a で、固定前の env の写し（`mastraOriginalEnv()`）と名前引き（`mastraOriginalEnvValue()`）を、
 * 子 process の env を組む箇所と env を読む箇所へ配線した（DR-MP3-9）。`apply()` の前は live の `process.env` と同じ値。
 *
 * - 固定する値：`MASTRA_TELEMETRY_DISABLED` は厳密に `"1"`（`0`・`disabled`・空文字は無効化にならない）、
 *   `MASTRA_OFFLINE` は `"true"`。
 * - 除く env は、名前を 1 つずつ並べず、型で除く（安全側）。core の dist は `*_API_KEY` を約 190 名参照し、
 *   名前の列挙では漏れる（`process.env[変数]` や `loadOptionalSetting` が読む名前を grep で拾えない）。
 *   - 名前の先頭：`MASTRA_`（`MASTRA_DEV`・`MASTRA_AUTO_REFRESH_PROVIDERS`・license 系）、`OM_`
 *     （`OM_DEBUG` は cwd の `om-debug.log` への書込み、`OM_REPRO_CAPTURE*` は会話の再現 file の書込み）、
 *     `AI_GATEWAY_`、`VERCEL_`（`VERCEL_OIDC_TOKEN` を含む）。
 *   - 名前の末尾：`_API_KEY`、`_API_TOKEN`、`_ACCESS_TOKEN`、`_SECRET`、`_SECRET_KEY`、`_TOKEN`、`_PASSWORD`、
 *     `_PRIVATE_KEY`、`_BASE_URL`（宛先を変えうる）。
 *   - 明示の名前：memory が attachment の token 数を POST する 3 社の API key（M13(a)）と、
 *     宛先・接続先を決める `DATABASE_URL`、`AZURE_RESOURCE_NAME`。
 *   - 利用者の shell の env は Electron に継承されるので、ここで落とす。
 * - 子 process（`cliAi`／`codexAppServer`）は `process.env` から env を組む。固定を当てた後の
 *   `process.env` を渡すと旗が閉じていても挙動が変わるので、元の env の写しを `originalEnv()` で渡す。
 *   写しを渡す配線は MP-3a（`mastraOriginalEnv()`）。
 * - 除かない名前（許可リスト）：Grimodex 自身の owner token の 5 名だけを、実名で、除去規則より先に当てて残す
 *   （`MASTRA_ALLOWED_ENV_NAMES`。`GRIMODEX_` 始まり全体の除外にはしない。新しい名前は既定で除去される。DR-MP3-8）。
 *   これらは末尾 `_TOKEN` の規則に当たるが、Rust（`std::env::var` の呼出し時読み）と preload が実行時に読む
 *   CI／journey の seam の鍵で、Mastra の dist は GRIMODEX の名前を読まない。
 *
 * このファイルは `@mastra/*` を import しない。
 */

/** 固定する env（値は厳密にこの文字列）。 */
export const MASTRA_PINNED_ENV = Object.freeze({
  MASTRA_TELEMETRY_DISABLED: "1",
  MASTRA_OFFLINE: "true",
} as const);

/** 名前の先頭がこれなら除く。 */
export const MASTRA_REMOVED_ENV_PREFIXES: readonly string[] = Object.freeze([
  "MASTRA_",
  "OM_",
  "AI_GATEWAY_",
  "VERCEL_",
]);

/** 名前の末尾がこれなら除く（key・token・secret・宛先）。 */
export const MASTRA_REMOVED_ENV_SUFFIXES: readonly string[] = Object.freeze([
  "_API_KEY",
  "_API_TOKEN",
  "_ACCESS_TOKEN",
  "_SECRET",
  "_SECRET_KEY",
  "_TOKEN",
  "_PASSWORD",
  "_PRIVATE_KEY",
  "_BASE_URL",
]);

/**
 * 名前が一致したら除く env（明示の一覧）。型の規則が当たらない名前も、ここに残す。
 * 3 社の key は M13(a)（memory が attachment の token 数を POST する）、`DATABASE_URL` と
 * `AZURE_RESOURCE_NAME` は接続先を決める。
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
  "DATABASE_URL",
  "AZURE_RESOURCE_NAME",
]);

/**
 * 除かない env（実名の許可リスト）。Grimodex 自身の owner token 5 名。除去規則（先頭・末尾・明示の名前）より先に当てる。
 * 名前の調査（2026-11-19）：製品の Rust が呼出し時に読む名前は GRIMODEX_／NIR1_ 始まりか SystemRoot で、API key は読まない。
 * `@mastra/*` の dist に GRIMODEX の名前は無い（静的 grep。動的な `process.env[変数]` は MP-3c の観測で閉じる）。
 * Mastra の版を上げるときは同じ grep を取り直す（計画書の第 11 節）。
 */
export const MASTRA_ALLOWED_ENV_NAMES: readonly string[] = Object.freeze([
  "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN",
  "GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN",
  "GRIMODEX_PROFILE_ACTIVATION_CI_OWNER_TOKEN",
  "GRIMODEX_NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
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
  // 実名の許可リストを先に当てる（比較は fold を通す。Windows では大小を問わない）。
  if (
    MASTRA_ALLOWED_ENV_NAMES.some((allowed) => key === fold(allowed, platform))
  ) {
    return false;
  }
  return (
    MASTRA_REMOVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    MASTRA_REMOVED_ENV_SUFFIXES.some((suffix) => key.endsWith(suffix)) ||
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
  /**
   * 固定を当てる前の env の 1 名の値。Windows では名前の大文字小文字を区別しない（`process.env` と同じ）。
   * `apply()` の前は live の env を引く（写しを撮らない）。
   */
  originalEnvValue(name: string): string | undefined;
  /** `apply()` が呼ばれたか。 */
  readonly applied: boolean;
}

export interface CreateMastraEnvPinOptions {
  /** 対象の env。既定は `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/**
 * Windows の `process.env` は名前の大文字小文字を区別しない。plain object の写しはその性質を失い、`PATH` の名前引きが
 * 実 key `Path` に当たらなくなるので、写しを大文字小文字を区別しない Proxy で包む（`Object.keys`・spread は実 key のまま）。
 */
function caseInsensitiveEnv(copy: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const find = (prop: string | symbol): string | undefined => {
    if (typeof prop !== "string") return undefined;
    if (Object.hasOwn(copy, prop)) return prop;
    const upper = prop.toUpperCase();
    return Object.keys(copy).find((key) => key.toUpperCase() === upper);
  };
  return new Proxy(copy, {
    get(target, prop, receiver) {
      const key = find(prop);
      return key === undefined
        ? Reflect.get(target, prop, receiver)
        : target[key];
    },
    has(target, prop) {
      return find(prop) !== undefined || Reflect.has(target, prop);
    },
    set(target, prop, value) {
      if (typeof prop !== "string") return Reflect.set(target, prop, value);
      target[find(prop) ?? prop] = value as string | undefined;
      return true;
    },
    deleteProperty(target, prop) {
      const key = find(prop);
      return key === undefined ? true : Reflect.deleteProperty(target, key);
    },
  });
}

export function createMastraEnvPin(
  options: CreateMastraEnvPinOptions = {},
): MastraEnvPin {
  // 既定の env は呼ぶたびに `process.env` を引く（試験などで process.env が差し替わっても live のまま）。
  const currentEnv = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let snapshot: Readonly<NodeJS.ProcessEnv> | undefined;
  let result: MastraEnvPinResult | undefined;

  return {
    apply(): MastraEnvPinResult {
      if (result) return result;
      const env = currentEnv();
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
      const copy = { ...(snapshot ?? currentEnv()) };
      return platform === "win32" ? caseInsensitiveEnv(copy) : copy;
    },
    originalEnvValue(name: string): string | undefined {
      const source = snapshot ?? currentEnv();
      if (Object.hasOwn(source, name)) return source[name];
      if (platform !== "win32") return undefined;
      const folded = fold(name, platform);
      const key = Object.keys(source).find((k) => fold(k, platform) === folded);
      return key === undefined ? undefined : source[key];
    },
    get applied(): boolean {
      return result !== undefined;
    },
  };
}

/**
 * main の全体で共有する pin（process に 1 つ）。製品の code が使うのは `mastraOriginalEnv()` と
 * `mastraOriginalEnvValue()` だけで、`apply()` へ届く入口は export しない（MP-3c が追加する。
 * 静的試験 mastraEnv.test.ts が、この file の外から `createMastraEnvPin` と共有 pin に触れないことを固定する）。
 */
const sharedPin: MastraEnvPin = createMastraEnvPin();

/** 固定を当てる前の env の写し（子 process に渡す用）。`apply()` の前は live の `process.env` の写しと同値。 */
export function mastraOriginalEnv(): NodeJS.ProcessEnv {
  return sharedPin.originalEnv();
}

/** 固定を当てる前の env の 1 名の値（`process.env[name]` の代わり）。 */
export function mastraOriginalEnvValue(name: string): string | undefined {
  return sharedPin.originalEnvValue(name);
}
