import type { AttributionStats } from "./attributionStats";
import type {
  AuthorshipTotals,
  ChapterAuthorshipReport,
  ProjectAuthorshipReport,
  SceneAuthorshipReport,
} from "./projectAuthorship";

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

// ── Project-wide Authorship Report (JSON / standalone HTML) ─────────────

/**
 * Emit the project-wide authorship report as canonicalised JSON.
 *
 * Stable key order (object literal order is preserved by JSON.stringify in V8)
 * keeps diffs across exports meaningful.
 */
export function exportAuthorshipJson(report: ProjectAuthorshipReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

/**
 * Stacked SVG bar — human (incl. unmarked) | ai | unknown.
 *
 * Width is fixed at 320×16 px; consumers wrap it in a container.
 * Colors are inlined as oklch() and degrade gracefully on older renderers.
 */
function renderBar(totals: AuthorshipTotals): string {
  const w = 320;
  const h = 16;
  const total = totals.total;
  if (total === 0) {
    return `<svg width="${w}" height="${h}" role="img" aria-label="no content"><rect width="${w}" height="${h}" fill="#eee"/></svg>`;
  }
  const humanW = ((totals.human + totals.unmarked) / total) * w;
  const aiW = (totals.ai / total) * w;
  const unknownW = (totals.unknown / total) * w;
  return [
    `<svg width="${w}" height="${h}" role="img" aria-label="authorship ratio">`,
    `<rect x="0" y="0" width="${humanW.toFixed(2)}" height="${h}" fill="oklch(0.65 0.10 220)"/>`,
    `<rect x="${humanW.toFixed(2)}" y="0" width="${aiW.toFixed(2)}" height="${h}" fill="oklch(0.65 0.18 250)"/>`,
    `<rect x="${(humanW + aiW).toFixed(2)}" y="0" width="${unknownW.toFixed(2)}" height="${h}" fill="oklch(0.65 0.05 0)"/>`,
    `</svg>`,
  ].join("");
}

function renderTotalsRow(t: AuthorshipTotals): string {
  const humanCount = t.human + t.unmarked;
  return `<td class="num">${t.total}</td><td class="num">${humanCount} (${pct(humanCount, t.total)}%)</td><td class="num">${t.ai} (${pct(t.ai, t.total)}%)</td><td class="num">${t.unknown} (${pct(t.unknown, t.total)}%)</td><td class="bar">${renderBar(t)}</td>`;
}

function renderSceneRow(scene: SceneAuthorshipReport): string {
  return `<tr class="scene"><td class="title scene-title">${escapeHtml(scene.title)}</td>${renderTotalsRow(scene.totals)}</tr>`;
}

function renderChapter(chapter: ChapterAuthorshipReport): string {
  const headerCells = renderTotalsRow(chapter.totals);
  const rows = chapter.scenes.map(renderSceneRow).join("\n");
  return `<tr class="chapter"><td class="title chapter-title">${escapeHtml(chapter.title)}</td>${headerCells}</tr>\n${rows}`;
}

/**
 * Standalone HTML export — no external CSS/JS, no fonts, no chart libs.
 *
 * Inline SVG bars keep the file self-contained so it can be archived or
 * forwarded without breaking when the user is offline.
 */
export function exportAuthorshipHtml(report: ProjectAuthorshipReport): string {
  const generated = report.generatedAt;
  const t = report.totals;
  const humanCount = t.human + t.unmarked;
  const humanPctTotal = pct(humanCount, t.total);
  const aiPctTotal = pct(t.ai, t.total);
  const unknownPctTotal = pct(t.unknown, t.total);

  const chapterRows = report.chapters.map(renderChapter).join("\n");
  const unparentedRows = report.unparentedScenes.map(renderSceneRow).join("\n");
  const unparentedBlock =
    report.unparentedScenes.length > 0
      ? `<tr class="chapter"><td class="title chapter-title">(unparented scenes)</td>${renderTotalsRow(
          report.unparentedScenes.reduce(
            (acc, s) => ({
              human: acc.human + s.totals.human,
              ai: acc.ai + s.totals.ai,
              unknown: acc.unknown + s.totals.unknown,
              unmarked: acc.unmarked + s.totals.unmarked,
              total: acc.total + s.totals.total,
              humanRatio: 0,
            }),
            {
              human: 0,
              ai: 0,
              unknown: 0,
              unmarked: 0,
              total: 0,
              humanRatio: 0,
            } as AuthorshipTotals,
          ),
        )}</tr>\n${unparentedRows}`
      : "";

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<title>Authorship Report — ${escapeHtml(report.projectTitle)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
.subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
.summary { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 1rem; align-items: center; margin-bottom: 2rem; padding: 1rem; border: 1px solid #ddd; border-radius: 8px; }
.summary .label { color: #666; font-size: 0.85rem; }
.summary .value { font-variant-numeric: tabular-nums; }
.summary .ratio { font-size: 1.6rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #eee; }
th { color: #666; font-weight: 500; text-align: right; }
th:first-child { text-align: left; }
td.num { text-align: right; font-variant-numeric: tabular-nums; color: #444; }
td.bar { width: 340px; }
tr.chapter td { font-weight: 600; border-top: 1px solid #ccc; background: #fafafa; }
tr.scene td.scene-title { padding-left: 1.5rem; color: #555; font-weight: 400; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #eee; color: #888; font-size: 0.75rem; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #ddd; }
  .summary { border-color: #333; }
  .subtitle, .summary .label, td.num, footer { color: #999; }
  tr.chapter td { background: #1a1a1a; border-top-color: #333; }
  tr.scene td.scene-title { color: #aaa; }
  th, td { border-bottom-color: #222; }
}
</style>
</head>
<body>
<h1>Authorship Report — ${escapeHtml(report.projectTitle)}</h1>
<p class="subtitle">Generated ${escapeHtml(generated)} · scope: ${escapeHtml(report.scope)}</p>

<section class="summary" aria-label="project totals">
  <div class="label">Total characters</div><div class="value">${t.total}</div>
  <div class="label">Human</div><div class="value">${humanCount} (${humanPctTotal}%)</div>
  <div class="label">AI</div><div class="value">${t.ai} (${aiPctTotal}%)</div>
  <div class="label">Unknown</div><div class="value">${t.unknown} (${unknownPctTotal}%)</div>
  <div class="label">Human ratio</div><div class="value ratio">${(t.humanRatio * 100).toFixed(1)}%</div>
  <div class="label">Breakdown</div><div class="value">${renderBar(t)}</div>
</section>

<table>
<thead>
<tr><th>Chapter / Scene</th><th>Total</th><th>Human</th><th>AI</th><th>Unknown</th><th>Bar</th></tr>
</thead>
<tbody>
${chapterRows}
${unparentedBlock}
</tbody>
</table>

<footer>
This report is a self-disclosure aid based on AuthorshipMark metadata. It does not
constitute legal proof of authorship; the tally reflects only what was attributed at
edit time. Unmarked text (typed before attribution tracking, or from imports) is
counted toward the human total.
</footer>
</body>
</html>
`;
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
