/**
 * desktop の renderer の build で `temporal-polyfill` の代わりに読む（条件は nativeTemporalBuild.ts）。
 *
 * temporal-polyfill 1.0.1 の入口は `globalThis.Temporal` があればそれを返す。Electron の Chromium は
 * 標準の Temporal を持つので、使う実装は変わらず、使われない polyfill の本体だけが起動時の JS から消える。
 */
import type { Temporal as PolyfillTemporal } from "temporal-polyfill";

const native = (globalThis as { Temporal?: unknown }).Temporal;
if (!native) {
  // undefined を黙って渡さず、読み込みの時点で理由を示して止める。
  throw new Error(
    "This renderer build requires a runtime with native Temporal.",
  );
}

export const Temporal = native as typeof PolyfillTemporal;
