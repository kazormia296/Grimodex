// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  exportAuthorshipJson,
  exportAuthorshipHtml,
  exportProvenanceDisclosureMarkdown,
  exportProvenanceDisclosureHtml,
  exportProvenanceDisclosureCsv,
  exportProvenanceDisclosureJson,
} from "./exportReport";
import { ATTRIBUTION_COLORS } from "./attributionColors";
import type { ProjectAuthorshipReport } from "./projectAuthorship";
import type { ProvenanceDisclosureReport, ResolvedPassage } from "./provenance";
import type { ProvenanceAnalyticsReport } from "./provenanceAnalytics";

const sampleReport: ProjectAuthorshipReport = {
  projectId: "p1",
  projectTitle: "<Edge & Co's> Novel",
  generatedAt: "2026-05-29T00:00:00.000Z",
  scope: "body-text-only",
  totals: {
    human: 280,
    ai: 10,
    unknown: 0,
    unmarked: 10,
    total: 300,
    humanRatio: 290 / 300,
  },
  chapters: [
    {
      id: "ch1",
      title: "Prologue",
      totals: {
        human: 280,
        ai: 10,
        unknown: 0,
        unmarked: 10,
        total: 300,
        humanRatio: 290 / 300,
      },
      scenes: [
        {
          id: "s1",
          title: "Opening <scene>",
          totals: {
            human: 80,
            ai: 10,
            unknown: 0,
            unmarked: 10,
            total: 100,
            humanRatio: 0.9,
          },
        },
      ],
    },
  ],
  unparentedScenes: [],
};

describe("exportAuthorshipJson", () => {
  it("emits canonical JSON ending in a newline", () => {
    const out = exportAuthorshipJson(sampleReport);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.projectId).toBe("p1");
    expect(parsed.totals.humanRatio).toBeCloseTo(290 / 300, 6);
    expect(parsed.chapters[0].scenes[0].id).toBe("s1");
    expect(parsed.scope).toBe("body-text-only");
  });
});

describe("exportAuthorshipHtml", () => {
  it("escapes user-provided titles to prevent HTML injection", () => {
    const out = exportAuthorshipHtml(sampleReport);
    expect(out).toContain("&lt;Edge &amp; Co&#39;s&gt; Novel");
    expect(out).toContain("Opening &lt;scene&gt;");
    expect(out).not.toContain("<Edge & Co's> Novel");
  });

  it("contains inline SVG bar markup (no external chart deps)", () => {
    const out = exportAuthorshipHtml(sampleReport);
    expect(out).toContain("<svg");
    expect(out).toContain("oklch(");
    // SVG fill は正本トークンと同色（teal/amber/blue）であること（色ドリフト検出）。
    expect(out).toContain(ATTRIBUTION_COLORS.ai);
    expect(out).toContain(ATTRIBUTION_COLORS.unknown);
    expect(out).not.toMatch(/<script\b/);
    expect(out).not.toMatch(/src="http/);
  });

  it("renders the project human-ratio prominently", () => {
    const out = exportAuthorshipHtml(sampleReport);
    expect(out).toContain("96.7%");
  });

  it("starts with an HTML5 doctype", () => {
    const out = exportAuthorshipHtml(sampleReport);
    expect(out.trimStart().startsWith("<!doctype html>")).toBe(true);
  });

  it("renders an unparented-scenes block when present", () => {
    const reportWithOrphans: ProjectAuthorshipReport = {
      ...sampleReport,
      unparentedScenes: [
        {
          id: "loose",
          title: "Loose scene",
          totals: {
            human: 50,
            ai: 0,
            unknown: 0,
            unmarked: 0,
            total: 50,
            humanRatio: 1,
          },
        },
      ],
    };
    const out = exportAuthorshipHtml(reportWithOrphans);
    expect(out).toContain("(unparented scenes)");
    expect(out).toContain("Loose scene");
  });
});

const passageWithChapter: ResolvedPassage = {
  id: "span-a",
  nodeId: "s1",
  from: 1,
  to: 8,
  charCount: 7,
  excerpt: "Hello world",
  model: "claude-sonnet-4-6",
  provenance: { kind: "inline-ai", traceId: "trace-1" },
  sceneTitle: "Opening",
  chapterTitle: "Prologue",
};

const passageUnparented: ResolvedPassage = {
  id: "span-b",
  nodeId: "s2",
  from: 1,
  to: 4,
  charCount: 3,
  excerpt: "abc",
  model: null,
  provenance: { kind: "chat" },
  sceneTitle: "Loose scene",
  chapterTitle: null,
};

const disclosureReport: ProvenanceDisclosureReport = {
  projectId: "p1",
  projectTitle: "Disclosure Sample",
  generatedAt: "2026-05-31T00:00:00.000Z",
  scope: "body-text-only",
  totals: {
    human: 200,
    ai: 10,
    unknown: 0,
    unmarked: 0,
    total: 210,
    humanRatio: 200 / 210,
  },
  breakdown: {
    chat: 3,
    inlineAi: 7,
    beat: 0,
    orphanChat: 0,
    unknownAi: 0,
  },
  orphanChatCount: 0,
  passages: [passageWithChapter, passageUnparented],
};

describe("exportProvenanceDisclosureMarkdown", () => {
  it("includes 'Chapter / Scene' for chaptered passages", () => {
    const out = exportProvenanceDisclosureMarkdown(disclosureReport);
    expect(out).toContain("Slash in Prologue / Opening");
  });

  it("includes scene title alone when the scene is unparented", () => {
    const out = exportProvenanceDisclosureMarkdown(disclosureReport);
    expect(out).toContain("Chat in Loose scene");
    expect(out).not.toContain("null / Loose scene");
  });
});

describe("exportProvenanceDisclosureHtml", () => {
  it("includes 'Chapter / Scene' for chaptered passages", () => {
    const out = exportProvenanceDisclosureHtml(disclosureReport);
    expect(out).toContain("in Prologue / Opening");
  });

  it("escapes scene and chapter titles", () => {
    const out = exportProvenanceDisclosureHtml({
      ...disclosureReport,
      passages: [
        {
          ...passageWithChapter,
          sceneTitle: "<scene>",
          chapterTitle: "<chap>",
        },
      ],
    });
    expect(out).toContain("&lt;chap&gt; / &lt;scene&gt;");
    expect(out).not.toContain("<chap> / <scene>");
  });
});

// Map AI content disclosure (security audit / 案A: Map provenance 可視化).
const mapReport: ProvenanceDisclosureReport = {
  ...disclosureReport,
  map: {
    totalAiChars: 42,
    stickyCount: 2,
    stickies: [
      {
        stickyId: "st1",
        boardId: "b1",
        boardTitle: "World",
        stickyTitle: "Dragon lore",
        charCount: 30,
        model: "claude",
      },
      {
        stickyId: "st2",
        boardId: "b1",
        boardTitle: "World",
        stickyTitle: "Castle",
        charCount: 12,
        model: null,
      },
    ],
  },
};

describe("provenance disclosure — Map AI content lane", () => {
  it("omits the Map section when there is no map AI content", () => {
    expect(exportProvenanceDisclosureMarkdown(disclosureReport)).not.toContain(
      "Map AI Content",
    );
    expect(exportProvenanceDisclosureHtml(disclosureReport)).not.toContain(
      "Map AI Content",
    );
  });

  it("renders a separate Map section (Markdown) without touching body totals", () => {
    const out = exportProvenanceDisclosureMarkdown(mapReport);
    expect(out).toContain("## Map AI Content");
    expect(out).toContain("| World | Dragon lore | 30 |");
    expect(out).toContain("| World | Castle | 12 |");
    expect(out).toContain("not part of the manuscript totals");
    // INVARIANT: body Summary / Provenance numbers are unchanged by the Map lane.
    const body = exportProvenanceDisclosureMarkdown(disclosureReport);
    for (const line of [
      "| AI | 10 | 5% |",
      "| Chat | 3 | 30% |",
      "| Slash | 7 | 70% |",
    ]) {
      expect(body).toContain(line);
      expect(out).toContain(line);
    }
  });

  it("renders a separate Map section (HTML), escaping labels", () => {
    const out = exportProvenanceDisclosureHtml({
      ...mapReport,
      map: {
        ...mapReport.map!,
        stickies: [
          { ...mapReport.map!.stickies[0], stickyTitle: "<b>evil</b>" },
        ],
        stickyCount: 1,
      },
    });
    expect(out).toContain("<h2>Map AI Content</h2>");
    expect(out).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(out).not.toContain("<b>evil</b>");
  });

  it("includes Map rows in CSV and the map field in JSON", () => {
    const csv = exportProvenanceDisclosureCsv(mapReport);
    expect(csv).toContain("Map board");
    expect(csv).toContain("Dragon lore");
    const parsed = JSON.parse(exportProvenanceDisclosureJson(mapReport));
    expect(parsed.map.totalAiChars).toBe(42);
    expect(parsed.totals.ai).toBe(10); // body totals untouched
  });
});

// Process disclosure (制作過程開示): per-passage prompt + output.
const chatPassageWithPrompt: ResolvedPassage = {
  id: "span-chat",
  nodeId: "s1",
  from: 1,
  to: 6,
  charCount: 5,
  excerpt: "hello",
  model: "claude-sonnet-4-6",
  provenance: { kind: "chat" },
  sceneTitle: "Opening",
  chapterTitle: "Prologue",
  disclosure: {
    userPrompt: "続きを書いて <script>x</script>",
    output: "hello <b>world</b>",
    sentSystemPrompt: "[system]\nYou are <inject>\n\n[user]\n続き",
    layers: [{ layer: "L1", label: "Project", used: 100 }],
    promptRecorded: true,
  },
};

const slashPassageNoPrompt: ResolvedPassage = {
  id: "span-slash",
  nodeId: "s1",
  from: 8,
  to: 12,
  charCount: 4,
  excerpt: "abcd",
  model: null,
  provenance: { kind: "inline-ai", traceId: "t1" },
  sceneTitle: "Opening",
  chapterTitle: "Prologue",
  disclosure: {
    userPrompt: "続きを書く",
    output: "abcd",
    sentSystemPrompt: null,
    layers: null,
    promptRecorded: false,
  },
};

const processReportFull: ProvenanceDisclosureReport = {
  ...disclosureReport,
  includePrompts: true,
  includeFullSystemPrompt: true,
  passages: [chatPassageWithPrompt, slashPassageNoPrompt],
};

const processReportLean: ProvenanceDisclosureReport = {
  ...disclosureReport,
  includePrompts: true,
  passages: [chatPassageWithPrompt, slashPassageNoPrompt],
};

describe("process disclosure — Markdown", () => {
  it("renders per-passage input/output under a process-disclosure heading", () => {
    const out = exportProvenanceDisclosureMarkdown(processReportLean);
    expect(out).toContain("## AI Passages (process disclosure)");
    expect(out).toContain("**入力 (Input):**");
    expect(out).toContain("**出力 (Output):**");
    // Indented code block keeps arbitrary text (incl. angle brackets) verbatim.
    expect(out).toContain("    続きを書いて <script>x</script>");
    expect(out).toContain("    hello <b>world</b>");
  });

  it("omits the full prompt block unless includeFullSystemPrompt is set", () => {
    const out = exportProvenanceDisclosureMarkdown(processReportLean);
    expect(out).not.toContain("送信プロンプト全文");
  });

  it("includes the full prompt block (and marks unrecorded ones) when requested", () => {
    const out = exportProvenanceDisclosureMarkdown(processReportFull);
    expect(out).toContain("**送信プロンプト全文 (Full prompt):**");
    // Every line of the multi-line prompt is indented into the code block.
    expect(out).toContain("    [system]\n    You are <inject>");
    // slash passage has no captured prompt → marked as unrecorded.
    expect(out).toContain("    (未記録)");
  });

  it("adds the cooperative-disclosure caveat to the footnote", () => {
    const out = exportProvenanceDisclosureMarkdown(processReportFull);
    expect(out).toContain("not tamper-proof third-party verification");
    expect(out).toContain("generated before this feature");
  });

  it("falls back to the plain passage list when prompts are not included", () => {
    const out = exportProvenanceDisclosureMarkdown(disclosureReport);
    expect(out).not.toContain("process disclosure");
    expect(out).not.toContain("**入力 (Input):**");
  });
});

describe("process disclosure — HTML", () => {
  it("escapes prompt and output content (no raw injection)", () => {
    const out = exportProvenanceDisclosureHtml(processReportFull);
    expect(out).toContain("AI Passages (process disclosure)");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>x</script>");
    expect(out).toContain("&lt;b&gt;world&lt;/b&gt;");
    expect(out).toContain("&lt;inject&gt;");
    expect(out).not.toContain("<inject>");
  });

  it("shows (未記録) for passages without a captured full prompt", () => {
    const out = exportProvenanceDisclosureHtml(processReportFull);
    expect(out).toContain("(未記録)");
  });
});

describe("process disclosure — JSON carries the disclosure payload", () => {
  it("includes per-passage disclosure objects", () => {
    const parsed = JSON.parse(
      exportProvenanceDisclosureJson(processReportFull),
    );
    expect(parsed.includePrompts).toBe(true);
    expect(parsed.passages[0].disclosure.userPrompt).toContain("続きを書いて");
    expect(parsed.passages[1].disclosure.promptRecorded).toBe(false);
  });
});

// ── Analytics section (additive, optional second arg) ──────────────────────
const analyticsReport: ProvenanceAnalyticsReport = {
  modelContribution: [
    { model: "claude-sonnet-4-6", chars: 7, passages: 1 },
    { model: "__unknown_model__", chars: 3, passages: 1 },
  ],
  kindDistribution: {
    chat: { chars: 3, passages: 1 },
    inlineAi: { chars: 7, passages: 1 },
    beat: { chars: 0, passages: 0 },
    orphanChat: { chars: 0, passages: 0 },
    unknownAi: { chars: 0, passages: 0 },
    totalChars: 10,
    totalPassages: 2,
  },
  costByModel: [
    { model: "claude-sonnet-4-6", costUsd: 0.5, calls: 2, estimated: true },
  ],
  costByKind: {
    byKind: {
      chat: { costUsd: 0.3, calls: 1, estimated: true },
      inlineAi: { costUsd: 0.2, calls: 1, estimated: true },
      beat: { costUsd: 0, calls: 0, estimated: false },
    },
    otherCostUsd: 0.1,
    totalCostUsd: 0.6,
    anyEstimated: true,
  },
  hasUsageData: true,
};

describe("disclosure analytics section", () => {
  it("omits the analytics section when no analytics arg is passed", () => {
    const md = exportProvenanceDisclosureMarkdown(disclosureReport);
    const html = exportProvenanceDisclosureHtml(disclosureReport);
    expect(md).not.toContain("Provenance Analytics");
    expect(html).not.toContain("Provenance Analytics");
  });

  it("renders model contribution and approx cost in markdown", () => {
    const md = exportProvenanceDisclosureMarkdown(
      disclosureReport,
      analyticsReport,
    );
    expect(md).toContain("## Provenance Analytics");
    expect(md).toContain("Contribution by model");
    expect(md).toContain("claude-sonnet-4-6");
    expect(md).toContain("Unknown model");
    // approx marker on cost
    expect(md).toContain("~$0.60");
  });

  it("renders the analytics section in html with approx cost", () => {
    const html = exportProvenanceDisclosureHtml(
      disclosureReport,
      analyticsReport,
    );
    expect(html).toContain("<h2>Provenance Analytics</h2>");
    expect(html).toContain("Approximate cost by provenance");
    expect(html).toContain("~$0.60");
  });

  it("hides the cost block when there is no usage data", () => {
    const md = exportProvenanceDisclosureMarkdown(disclosureReport, {
      ...analyticsReport,
      hasUsageData: false,
    });
    expect(md).toContain("## Provenance Analytics");
    expect(md).not.toContain("Approximate cost by provenance");
  });
});
