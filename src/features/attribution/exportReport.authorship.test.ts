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
import type { ProjectAuthorshipReport } from "./projectAuthorship";
import type { ProvenanceDisclosureReport, ResolvedPassage } from "./provenance";

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
