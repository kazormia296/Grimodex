import "vitest";
import type { AxeMatchers } from "vitest-axe/matchers";

// vitest-axe 0.1.0 の型拡張 (dist/extend-expect.d.ts) は廃止された
// `declare global { namespace Vi { interface Assertion } }` 形式で matcher を
// 足すが、vitest 4 では Assertion インターフェースが "vitest" モジュール側に
// 移っているため、その augmentation は効かず toHaveNoViolations が型に乗らない。
// @testing-library/jest-dom と同じく `declare module "vitest"` で手動拡張する。
// 型パラメータ数は vitest コアの `interface Assertion<T>` と一致させる
// (default を足すと TS2428 "identical type parameters" 衝突になりうる。名前は
// merge に影響しないので未使用警告回避で `_T` にしている)。
// module augmentation は空 extends interface が必須のため no-empty-object-type を
// この宣言ブロックに限り無効化する。
declare module "vitest" {
  /* eslint-disable @typescript-eslint/no-empty-object-type */
  interface Assertion<_T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
  /* eslint-enable @typescript-eslint/no-empty-object-type */
}
