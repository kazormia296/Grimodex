// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { exportAuthorshipJson, exportAuthorshipHtml } from "./exportReport";
import type { ProjectAuthorshipReport } from "./projectAuthorship";

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
