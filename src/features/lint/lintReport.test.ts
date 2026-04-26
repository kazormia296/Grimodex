import { describe, expect, it } from "vitest";
import {
  extensionFor,
  renderReport,
  toCsvReport,
  toJsonReport,
  toMarkdownReport,
} from "./lintReport";
import type { ScannedScene } from "./projectScan";

function mkScene(
  id: string,
  title: string,
  text: string,
  diagnostics: ScannedScene["diagnostics"],
): ScannedScene {
  return {
    sceneId: id,
    sceneTitle: title,
    sceneText: text,
    diagnostics,
    warnings: [],
  };
}

const scenes: ScannedScene[] = [
  mkScene("s1", "第一章", "彼は走った。また走る。", [
    {
      rule_id: "ja/word-repetition",
      severity: "info",
      message: "「走る」が近距離で繰り返されています",
      range: { start: 0, end: 1 },
    },
  ]),
  mkScene("s2", "幕間", "問題なし。", []),
];

describe("CSV report", () => {
  it("header + one row per diagnostic", () => {
    const out = toCsvReport(scenes, { includeExcerpt: false });
    const rows = out.trim().split("\n");
    expect(rows[0]).toBe(
      "scene_id,scene_title,rule_id,severity,message,range_start,range_end",
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("s1");
    expect(rows[1]).toContain("ja/word-repetition");
  });

  it("escapes commas and quotes", () => {
    const withComma = mkScene("s1", "a,b", "text", [
      {
        rule_id: "r",
        severity: "info",
        message: 'has "quote"',
        range: { start: 0, end: 1 },
      },
    ]);
    const out = toCsvReport([withComma], { includeExcerpt: false });
    expect(out).toContain('"a,b"');
    expect(out).toContain('"has ""quote"""');
  });

  it("includes excerpt column when enabled", () => {
    const out = toCsvReport(scenes, { includeExcerpt: true });
    const rows = out.trim().split("\n");
    expect(rows[0]).toContain("excerpt");
    expect(rows[1]).toContain("[彼]"); // range 0..1 marks "彼"
  });
});

describe("Markdown report", () => {
  it("omits scenes without diagnostics", () => {
    const md = toMarkdownReport(scenes, { includeExcerpt: false });
    expect(md).toContain("## 第一章");
    expect(md).not.toContain("## 幕間");
  });

  it("counts totals in header", () => {
    const md = toMarkdownReport(scenes, { includeExcerpt: false });
    expect(md).toContain("🔴 0");
    expect(md).toContain("ⓘ 1");
  });

  it("embeds project title when provided", () => {
    const md = toMarkdownReport(scenes, {
      projectTitle: "ほげ",
      includeExcerpt: false,
    });
    expect(md.startsWith("# Lint レポート: ほげ")).toBe(true);
  });
});

describe("JSON report", () => {
  it("valid JSON with summary and per-scene breakdown", () => {
    const json = toJsonReport(scenes, { includeExcerpt: false });
    const parsed = JSON.parse(json);
    expect(parsed.summary.scenesScanned).toBe(2);
    expect(parsed.summary.scenesWithDiagnostics).toBe(1);
    expect(parsed.summary.totals.info).toBe(1);
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.scenes[0].diagnostics[0].rule_id).toBe("ja/word-repetition");
  });

  it("omits excerpt field when disabled", () => {
    const json = toJsonReport(scenes, { includeExcerpt: false });
    expect(JSON.parse(json).scenes[0].diagnostics[0].excerpt).toBeUndefined();
  });

  it("includes excerpt field when enabled", () => {
    const json = toJsonReport(scenes, { includeExcerpt: true });
    expect(typeof JSON.parse(json).scenes[0].diagnostics[0].excerpt).toBe(
      "string",
    );
  });
});

describe("dispatcher", () => {
  it("renderReport routes correctly", () => {
    expect(renderReport("csv", scenes, { includeExcerpt: false })).toContain(
      "scene_id",
    );
    expect(
      renderReport("markdown", scenes, { includeExcerpt: false }),
    ).toContain("# Lint レポート");
    expect(renderReport("json", scenes, { includeExcerpt: false })).toContain(
      "summary",
    );
  });

  it("extensionFor returns the right extension", () => {
    expect(extensionFor("csv")).toBe("csv");
    expect(extensionFor("markdown")).toBe("md");
    expect(extensionFor("json")).toBe("json");
  });
});
