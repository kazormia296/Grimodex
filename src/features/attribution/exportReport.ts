import type { AttributionStats } from "./attributionStats";
import type {
  AuthorshipTotals,
  ChapterAuthorshipReport,
  ProjectAuthorshipReport,
  SceneAuthorshipReport,
} from "./projectAuthorship";
import type {
  MapProvenance,
  ProvenanceDisclosureReport,
  ProvenanceKind,
  ResolvedPassage,
} from "./provenance";

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

export function exportProvenanceDisclosureJson(
  report: ProvenanceDisclosureReport,
): string {
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

/** Sanitize a Markdown table cell: collapse newlines, escape pipes. */
function mdCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function provenanceKindLabel(kind: ProvenanceKind): string {
  switch (kind) {
    case "chat":
      return "Chat";
    case "inline-ai":
      return "Slash";
    case "beat":
      return "Beat";
    case "orphan-chat":
      return "Deleted chat";
    case "unknown":
      return "Unknown AI";
  }
}

function passageDocumentLabel(passage: ResolvedPassage): string {
  if (!passage.sceneTitle) return "";
  return passage.chapterTitle
    ? `${passage.chapterTitle} / ${passage.sceneTitle}`
    : passage.sceneTitle;
}

function disclosureFootnote(report: ProvenanceDisclosureReport): string {
  const orphan =
    report.orphanChatCount > 0
      ? ` ${report.orphanChatCount} passage(s) reference deleted chat messages.`
      : "";
  return `This disclosure reflects remaining AI-attributed spans at export time.${orphan} Legacy or manually inserted AI text without provenance is counted as Unknown AI.`;
}

export function exportProvenanceDisclosureMarkdown(
  report: ProvenanceDisclosureReport,
): string {
  const t = report.totals;
  const human = t.human + t.unmarked;
  const lines = [
    `# AI Usage Disclosure: ${report.projectTitle}`,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `| Source | Characters | Percentage |`,
    `|--------|------------|------------|`,
    `| Human / unmarked | ${human} | ${pct(human, t.total)}% |`,
    `| AI | ${t.ai} | ${pct(t.ai, t.total)}% |`,
    `| Unknown | ${t.unknown} | ${pct(t.unknown, t.total)}% |`,
    `| Total | ${t.total} |  |`,
    "",
    "## AI Provenance",
    "",
    `| Kind | Characters | % of AI |`,
    `|------|------------|---------|`,
    `| Chat | ${report.breakdown.chat} | ${pct(report.breakdown.chat, t.ai)}% |`,
    `| Slash | ${report.breakdown.inlineAi} | ${pct(report.breakdown.inlineAi, t.ai)}% |`,
    `| Beat | ${report.breakdown.beat} | ${pct(report.breakdown.beat, t.ai)}% |`,
    `| Deleted chat | ${report.breakdown.orphanChat} | ${pct(report.breakdown.orphanChat, t.ai)}% |`,
    `| Unknown AI | ${report.breakdown.unknownAi} | ${pct(report.breakdown.unknownAi, t.ai)}% |`,
    "",
  ];

  if (report.passages?.length) {
    lines.push("## AI Passages", "");
    for (const passage of report.passages) {
      const document = passageDocumentLabel(passage);
      const location = document ? ` in ${document}` : "";
      lines.push(
        `- ${provenanceKindLabel(passage.provenance.kind)}${location} (${passage.charCount} chars): ${passage.excerpt}`,
      );
    }
    lines.push("");
  }

  if (report.map && report.map.stickyCount > 0) {
    const m = report.map;
    lines.push(
      "## Map AI Content",
      "",
      `${m.stickyCount} sticky note(s), ${m.totalAiChars} AI-authored characters. Listed separately — not part of the manuscript totals above. Counts reflect AI content at branch-adoption time and may overstate it if a sticky was later edited by hand.`,
      "",
      `| Board | Sticky | Characters |`,
      `|-------|--------|------------|`,
    );
    for (const s of m.stickies) {
      lines.push(
        `| ${mdCell(s.boardTitle)} | ${mdCell(s.stickyTitle)} | ${s.charCount} |`,
      );
    }
    lines.push("");
  }

  lines.push(disclosureFootnote(report), "");
  return lines.join("\n");
}

export function exportProvenanceDisclosureCsv(
  report: ProvenanceDisclosureReport,
): string {
  const rows = [
    ["Kind", "Characters"],
    ["Chat", String(report.breakdown.chat)],
    ["Slash", String(report.breakdown.inlineAi)],
    ["Beat", String(report.breakdown.beat)],
    ["Deleted chat", String(report.breakdown.orphanChat)],
    ["Unknown AI", String(report.breakdown.unknownAi)],
  ];
  if (report.passages?.length) {
    rows.push(["", ""]);
    rows.push(["Passage kind", "Excerpt"]);
    for (const passage of report.passages) {
      rows.push([
        provenanceKindLabel(passage.provenance.kind),
        passage.excerpt,
      ]);
    }
  }
  if (report.map && report.map.stickyCount > 0) {
    rows.push(["", ""]);
    rows.push(["Map board", "Map sticky", "Characters"]);
    for (const s of report.map.stickies) {
      rows.push([s.boardTitle, s.stickyTitle, String(s.charCount)]);
    }
  }
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
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

function renderPassageList(passages: ResolvedPassage[] | undefined): string {
  if (!passages?.length) return "";
  return `<section><h2>AI Passages</h2><ul>${passages
    .map((p) => {
      const document = passageDocumentLabel(p);
      const location = document
        ? ` <span class="document">in ${escapeHtml(document)}</span>`
        : "";
      return `<li><strong>${escapeHtml(provenanceKindLabel(p.provenance.kind))}</strong>${location} (${p.charCount} chars): ${escapeHtml(p.excerpt)}</li>`;
    })
    .join("")}</ul></section>`;
}

function renderMapDisclosure(map: MapProvenance | undefined): string {
  if (!map || map.stickyCount === 0) return "";
  const rows = map.stickies
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.boardTitle)}</td><td>${escapeHtml(s.stickyTitle)}</td><td class="num">${s.charCount}</td></tr>`,
    )
    .join("");
  return `<section><h2>Map AI Content</h2><p>${map.stickyCount} sticky note(s), ${map.totalAiChars} AI-authored characters — separate from the manuscript totals. Counts reflect AI content at branch-adoption time and may overstate it if a sticky was later edited by hand.</p><table><thead><tr><th>Board</th><th>Sticky</th><th>Characters</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function exportProvenanceDisclosureHtml(
  report: ProvenanceDisclosureReport,
): string {
  const t = report.totals;
  const human = t.human + t.unmarked;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<title>AI Usage Disclosure — ${escapeHtml(report.projectTitle)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; margin: 2rem auto; max-width: 840px; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.4rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 1rem 0 2rem; }
th, td { border-bottom: 1px solid #ddd; padding: 0.45rem 0.6rem; text-align: left; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
li { margin: 0.4rem 0; }
footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #777; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>AI Usage Disclosure — ${escapeHtml(report.projectTitle)}</h1>
<p>Generated ${escapeHtml(report.generatedAt)}</p>
<h2>Summary</h2>
<table>
<tbody>
<tr><th>Total characters</th><td class="num">${t.total}</td></tr>
<tr><th>Human / unmarked</th><td class="num">${human} (${pct(human, t.total)}%)</td></tr>
<tr><th>AI</th><td class="num">${t.ai} (${pct(t.ai, t.total)}%)</td></tr>
<tr><th>Unknown</th><td class="num">${t.unknown} (${pct(t.unknown, t.total)}%)</td></tr>
</tbody>
</table>
<h2>AI Provenance</h2>
<table>
<tbody>
<tr><th>Chat</th><td class="num">${report.breakdown.chat}</td></tr>
<tr><th>Slash</th><td class="num">${report.breakdown.inlineAi}</td></tr>
<tr><th>Beat</th><td class="num">${report.breakdown.beat}</td></tr>
<tr><th>Deleted chat</th><td class="num">${report.breakdown.orphanChat}</td></tr>
<tr><th>Unknown AI</th><td class="num">${report.breakdown.unknownAi}</td></tr>
</tbody>
</table>
${renderPassageList(report.passages)}
${renderMapDisclosure(report.map)}
<footer>${escapeHtml(disclosureFootnote(report))}</footer>
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
