import { describe, it, expect } from "vitest";
import { mergeWarnings } from "./lintStore";
import type { RuleWarning } from "./types";

function w(
  rule_id: string,
  kind: RuleWarning["kind"],
  message = "",
): RuleWarning {
  return { rule_id, kind, message };
}

describe("mergeWarnings", () => {
  it("dedup: same rule_id+kind keeps incoming message", () => {
    const existing = [w("ja/foo", "InitFailed", "old")];
    const incoming = [w("ja/foo", "InitFailed", "new")];
    const result = mergeWarnings(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("new");
  });

  it("retention: existing key absent from incoming is kept", () => {
    const existing = [w("ja/foo", "InitFailed", "persisted")];
    const incoming = [w("ja/bar", "Skipped", "")];
    const result = mergeWarnings(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.rule_id === "ja/foo")).toBe(true);
  });

  it("preservation: empty incoming leaves existing unchanged", () => {
    const existing = [w("ja/foo", "InitFailed", "persisted")];
    const result = mergeWarnings(existing, []);
    expect(result).toHaveLength(1);
    expect(result[0].rule_id).toBe("ja/foo");
  });
});
