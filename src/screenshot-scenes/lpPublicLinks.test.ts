import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const lpSource = readFileSync(
  resolve(process.cwd(), "docs/lp/lp-variant-h.jsx"),
  "utf8",
);
const lpBundle = readFileSync(
  resolve(process.cwd(), "docs/lp/assets/lp-app.js"),
  "utf8",
);

const WEB_EDITOR_URL = "https://grimodex-try.pages.dev/";

describe("LP public links", () => {
  it("offers the production Web Editor with Japanese and English CTA copy", () => {
    expect(lpSource).toContain(`href="${WEB_EDITOR_URL}"`);
    expect(lpSource).toContain('"ブラウザで試す"');
    expect(lpSource).toContain('"Try in your browser"');
    expect(lpBundle).toContain(WEB_EDITOR_URL);
  });

  it("opens the Web Editor safely without exposing the staging deployment", () => {
    const webEditorLink = lpSource.match(
      /<a\s+href="https:\/\/grimodex-try\.pages\.dev\/"[\s\S]*?<\/a>/,
    )?.[0];

    expect(webEditorLink).toBeDefined();
    expect(webEditorLink).toContain('target="_blank"');
    expect(webEditorLink).toContain('rel="noreferrer"');
    expect(lpSource).not.toContain("grimodex-try-staging.pages.dev");
    expect(lpBundle).not.toContain("grimodex-try-staging.pages.dev");
  });
});
