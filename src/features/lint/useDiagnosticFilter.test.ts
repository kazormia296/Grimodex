import { describe, expect, it } from "vitest";
import {
  filterDiagnostics,
  groupByRule,
  groupBySeverity,
  matchesDiagnosticFilter,
} from "./useDiagnosticFilter";
import type { Diagnostic } from "./types";

const D = (
  id: string,
  severity: "error" | "warning" | "info",
  msg: string,
  start = 0,
  end = 1,
): Diagnostic => ({
  rule_id: id,
  severity,
  message: msg,
  range: { start, end },
});

describe("matchesDiagnosticFilter", () => {
  it("hides a diagnostic whose severity is toggled off", () => {
    const d = D("r", "warning", "hello");
    expect(
      matchesDiagnosticFilter(
        d,
        { error: true, warning: false, info: true },
        "",
      ),
    ).toBe(false);
  });

  it("matches by rule_id substring (case-insensitive)", () => {
    const d = D("foo-rule", "info", "anything");
    expect(
      matchesDiagnosticFilter(
        d,
        { error: true, warning: true, info: true },
        "FOO",
      ),
    ).toBe(true);
  });

  it("matches by message substring", () => {
    const d = D("r", "info", "Watch your tone");
    expect(
      matchesDiagnosticFilter(
        d,
        { error: true, warning: true, info: true },
        "tone",
      ),
    ).toBe(true);
  });

  it("treats whitespace-only query as no query", () => {
    const d = D("r", "info", "anything");
    expect(
      matchesDiagnosticFilter(
        d,
        { error: true, warning: true, info: true },
        "   ",
      ),
    ).toBe(true);
  });
});

describe("filterDiagnostics", () => {
  const list = [
    D("a", "error", "boom"),
    D("b", "warning", "careful"),
    D("c", "info", "fyi"),
  ];

  it("filters by severity flags", () => {
    expect(
      filterDiagnostics(
        list,
        { error: false, warning: true, info: false },
        "",
      ).map((d) => d.rule_id),
    ).toEqual(["b"]);
  });

  it("filters by query", () => {
    expect(
      filterDiagnostics(
        list,
        { error: true, warning: true, info: true },
        "fyi",
      ).map((d) => d.rule_id),
    ).toEqual(["c"]);
  });
});

describe("groupBySeverity", () => {
  it("buckets items by severity in error→warning→info order, dropping empties", () => {
    const list = [D("a", "info", ""), D("b", "error", ""), D("c", "info", "")];
    const groups = groupBySeverity(list, (d) => d.severity);
    expect(groups.map((g) => g.key)).toEqual(["error", "info"]);
    expect(groups[1].items.map((d) => d.rule_id)).toEqual(["a", "c"]);
  });

  it("respects keyPrefix so callers can namespace group keys", () => {
    const list = [D("a", "warning", "")];
    const [g] = groupBySeverity(list, (d) => d.severity, "sev:");
    expect(g.key).toBe("sev:warning");
  });
});

describe("groupByRule", () => {
  it("buckets items by rule_id sorted lexicographically", () => {
    const list = [
      D("zeta", "info", ""),
      D("alpha", "info", ""),
      D("alpha", "info", ""),
    ];
    const groups = groupByRule(list, (d) => d.rule_id);
    expect(groups.map((g) => g.key)).toEqual(["rule:alpha", "rule:zeta"]);
    expect(groups[0].items.length).toBe(2);
    expect(groups[0].label).toBe("alpha (2)");
  });
});
