import type { AttributionStats } from "./attributionStats";

/**
 * Export attribution stats as a Markdown report.
 */
export function exportAttributionMarkdown(
  stats: AttributionStats,
  title: string,
): string {
  const humanTotal = stats.human + stats.unmarked;
  const pct = (n: number) =>
    stats.total > 0 ? Math.round((n / stats.total) * 100) : 0;

  const lines = [
    `# Attribution Report: ${title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `| Source   | Characters | Percentage |`,
    `|----------|-----------|------------|`,
    `| Human    | ${humanTotal}        | ${pct(humanTotal)}%         |`,
    `| AI       | ${stats.ai}        | ${pct(stats.ai)}%         |`,
    `| Unknown  | ${stats.unknown}        | ${pct(stats.unknown)}%         |`,
    `| **Total**| **${stats.total}**  |            |`,
    "",
  ];

  if (Object.keys(stats.modelBreakdown).length > 0) {
    lines.push("## AI Model Breakdown", "");
    lines.push(`| Model | Characters | % of AI |`);
    lines.push(`|-------|-----------|---------|`);
    for (const [model, count] of Object.entries(stats.modelBreakdown)) {
      const pctOfAi = stats.ai > 0 ? Math.round((count / stats.ai) * 100) : 0;
      lines.push(`| ${model} | ${count} | ${pctOfAi}% |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Export attribution stats as CSV.
 */
export function exportAttributionCsv(
  stats: AttributionStats,
  title: string,
): string {
  const humanTotal = stats.human + stats.unmarked;
  const pct = (n: number) =>
    stats.total > 0 ? Math.round((n / stats.total) * 100) : 0;

  const rows = [
    ["Document", "Source", "Characters", "Percentage"],
    [title, "Human", String(humanTotal), `${pct(humanTotal)}%`],
    [title, "AI", String(stats.ai), `${pct(stats.ai)}%`],
    [title, "Unknown", String(stats.unknown), `${pct(stats.unknown)}%`],
    [title, "Total", String(stats.total), ""],
  ];

  if (Object.keys(stats.modelBreakdown).length > 0) {
    rows.push(["", "", "", ""]);
    rows.push(["Model", "Characters", "% of AI", ""]);
    for (const [model, count] of Object.entries(stats.modelBreakdown)) {
      const pctOfAi = stats.ai > 0 ? Math.round((count / stats.ai) * 100) : 0;
      rows.push([model, String(count), `${pctOfAi}%`, ""]);
    }
  }

  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

/** Trigger a file download in the browser */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
