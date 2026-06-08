import { expect } from "vitest";
import { axe } from "vitest-axe";

export { axe };

/**
 * 与えられた要素ツリーを axe-core で検査し、アクセシビリティ違反が無いことを
 * assert する薄いヘルパ。各 panel / dialog の smoke test 用。
 *
 * 注意: happy-dom 環境が必要 (テストファイル先頭に
 * `// @vitest-environment happy-dom` を付けること)。matcher は test-setup.ts で
 * 登録済み。
 */
export async function expectNoA11yViolations(
  container: Element,
): Promise<void> {
  const results = await axe(container);
  expect(results).toHaveNoViolations();
}
