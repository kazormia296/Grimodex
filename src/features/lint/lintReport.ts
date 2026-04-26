/**
 * Lint レポートのエクスポート（設計書 §Lint レポートのエクスポート）。
 *
 * CSV / Markdown / JSON の 3 形式を提供。本文抜粋は opt-in
 * （`includeExcerpt`）— 未発表原稿の抜粋を含めずに集計だけ出力する
 * ユースケース用。
 */

import type { ScannedScene } from "./projectScan";
import type { Diagnostic, Severity } from "./types";

export type ReportFormat = "csv" | "markdown" | "json";

export interface ReportOptions {
  projectTitle?: string;
  includeExcerpt: boolean;
}

const SEVERITY_MARK: Record<Severity, string> = {
  error: "🔴",
  warning: "⚠",
  info: "ⓘ",
};

/** Length of the excerpt taken from the scene text for each diagnostic. */
const EXCERPT_CONTEXT = 20;

function excerptFor(sceneText: string, d: Diagnostic): string {
  const start = Math.max(0, Math.min(d.range.start, sceneText.length));
  const end = Math.max(start, Math.min(d.range.end, sceneText.length));
  const hit = sceneText.slice(start, end);
  if (hit.length > 60) {
    return `${hit.slice(0, 30)}…${hit.slice(-30)}`;
  }
  const before = sceneText.slice(Math.max(0, start - EXCERPT_CONTEXT), start);
  const after = sceneText.slice(
    end,
    Math.min(sceneText.length, end + EXCERPT_CONTEXT),
  );
  return `${before}[${hit}]${after}`;
}

// ── CSV ──

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsvReport(
  scenes: ScannedScene[],
  opts: ReportOptions,
): string {
  const header = [
    "scene_id",
    "scene_title",
    "rule_id",
    "severity",
    "message",
    "range_start",
    "range_end",
  ];
  if (opts.includeExcerpt) header.push("excerpt");

  const lines: string[] = [header.join(",")];
  for (const scene of scenes) {
    for (const d of scene.diagnostics) {
      const cells = [
        scene.sceneId,
        scene.sceneTitle,
        d.rule_id,
        d.severity,
        d.message,
        String(d.range.start),
        String(d.range.end),
      ];
      if (opts.includeExcerpt) {
        cells.push(excerptFor(scene.sceneText, d));
      }
      lines.push(cells.map(csvEscape).join(","));
    }
  }
  return lines.join("\n") + "\n";
}

// ── Markdown ──

export function toMarkdownReport(
  scenes: ScannedScene[],
  opts: ReportOptions,
): string {
  const lines: string[] = [];
  const title = opts.projectTitle
    ? `# Lint レポート: ${opts.projectTitle}`
    : "# Lint レポート";
  lines.push(title, "");

  const totals = { error: 0, warning: 0, info: 0 };
  for (const scene of scenes) {
    for (const d of scene.diagnostics) totals[d.severity] += 1;
  }
  const scannedCount = scenes.length;
  const withDiagsCount = scenes.filter((s) => s.diagnostics.length > 0).length;
  lines.push(
    `対象シーン: ${scannedCount}（うち指摘あり: ${withDiagsCount}）  `,
    `🔴 ${totals.error}  ⚠ ${totals.warning}  ⓘ ${totals.info}`,
    "",
  );

  for (const scene of scenes) {
    if (scene.diagnostics.length === 0) continue;
    lines.push(`## ${scene.sceneTitle}`, "");
    for (const d of scene.diagnostics) {
      const mark = SEVERITY_MARK[d.severity];
      lines.push(`### ${mark} \`${d.rule_id}\``, "", d.message, "");
      if (opts.includeExcerpt) {
        const ex = excerptFor(scene.sceneText, d);
        lines.push("> " + ex.replace(/\n/g, " "), "");
      }
    }
  }
  return lines.join("\n");
}

// ── JSON ──

export interface JsonReport {
  generatedAt: string;
  projectTitle: string | null;
  summary: {
    scenesScanned: number;
    scenesWithDiagnostics: number;
    totals: { error: number; warning: number; info: number };
  };
  scenes: Array<{
    sceneId: string;
    sceneTitle: string;
    diagnostics: Array<
      Diagnostic & { excerpt?: string; sceneTitle: string; sceneId: string }
    >;
  }>;
}

export function toJsonReport(
  scenes: ScannedScene[],
  opts: ReportOptions,
): string {
  const totals = { error: 0, warning: 0, info: 0 };
  for (const scene of scenes) {
    for (const d of scene.diagnostics) totals[d.severity] += 1;
  }
  const payload: JsonReport = {
    generatedAt: new Date().toISOString(),
    projectTitle: opts.projectTitle ?? null,
    summary: {
      scenesScanned: scenes.length,
      scenesWithDiagnostics: scenes.filter((s) => s.diagnostics.length > 0)
        .length,
      totals,
    },
    scenes: scenes.map((s) => ({
      sceneId: s.sceneId,
      sceneTitle: s.sceneTitle,
      diagnostics: s.diagnostics.map((d) => ({
        ...d,
        sceneId: s.sceneId,
        sceneTitle: s.sceneTitle,
        ...(opts.includeExcerpt ? { excerpt: excerptFor(s.sceneText, d) } : {}),
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function renderReport(
  format: ReportFormat,
  scenes: ScannedScene[],
  opts: ReportOptions,
): string {
  switch (format) {
    case "csv":
      return toCsvReport(scenes, opts);
    case "markdown":
      return toMarkdownReport(scenes, opts);
    case "json":
      return toJsonReport(scenes, opts);
  }
}

export function extensionFor(format: ReportFormat): string {
  switch (format) {
    case "csv":
      return "csv";
    case "markdown":
      return "md";
    case "json":
      return "json";
  }
}
