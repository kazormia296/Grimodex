// addMessage の retry（同じ id の再実行）で、保存済みの行が同じ内容かを判定する。

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSubset(expected: unknown, actual: unknown): boolean {
  if (Object.is(expected, actual)) {
    return true;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isJsonSubset(value, actual[index]))
    );
  }
  if (!isJsonRecord(expected) || !isJsonRecord(actual)) {
    return false;
  }
  return Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(actual, key) && isJsonSubset(value, actual[key]),
  );
}

export function isRetryCompatibleMetadata(
  expected: string | null,
  actual: string | null,
): boolean {
  if (expected === actual) {
    return true;
  }
  try {
    const actualValue = actual === null ? null : JSON.parse(actual);
    if (expected === null) {
      return isJsonRecord(actualValue);
    }
    return isJsonSubset(JSON.parse(expected), actualValue);
  } catch {
    // Legacy non-JSON metadata remains byte-for-byte only.
    return false;
  }
}
