import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EULA_VERSION } from "./constants";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("EULA_VERSION", () => {
  it("matches both bundled Terms versions so a material policy update re-prompts", () => {
    for (const locale of ["ja", "en"]) {
      const terms = readFileSync(
        resolve(REPO_ROOT, `public/TERMS_${locale}.md`),
        "utf8",
      );
      expect(terms).toContain(`v${EULA_VERSION}`);
    }
  });

  it("ships localized editor-only privacy notices with BYOK safeguards", () => {
    const expectedEditorOnlyCopy = {
      ja: [
        `バージョン: v${EULA_VERSION}`,
        "Web Editor 試用版",
        "現在のブラウザプロファイルの IndexedDB",
        "現在のブラウザプロファイルの Local Storage",
        "現在のページの実行メモリ",
        "実際の接続先",
        "Ollama",
        "OpenAI／Anthropic BYOK",
        "handoff ファイル",
      ],
      en: [
        `Version: v${EULA_VERSION}`,
        "Web Editor trial",
        "IndexedDB in the current browser profile",
        "Local Storage in the current browser profile",
        "current page's runtime memory",
        "actual destination",
        "Ollama",
        "OpenAI / Anthropic BYOK",
        "handoff file",
      ],
    } as const;
    const retiredHostedTerms = [
      "Grimodex Scan",
      "Hosted AI",
      "Cloudflare R2",
      "Cloudflare D1",
      "Cloudflare Access",
      "OpenRouter",
      "public report",
      "公開レポート",
    ];
    for (const locale of ["ja", "en"] as const) {
      const privacy = readFileSync(
        resolve(REPO_ROOT, `public/PRIVACY_${locale}.md`),
        "utf8",
      );
      expect(privacy).toContain("GDX-AI-CONSENT-001");
      for (const expected of expectedEditorOnlyCopy[locale]) {
        expect(privacy).toContain(expected);
      }
      for (const retired of retiredHostedTerms) {
        expect(privacy).not.toContain(retired);
      }
    }
  });

  it("removes hosted manuscript processing from both Terms versions", () => {
    for (const locale of ["ja", "en"] as const) {
      const terms = readFileSync(
        resolve(REPO_ROOT, `public/TERMS_${locale}.md`),
        "utf8",
      );
      expect(terms).toContain("IndexedDB");
      expect(terms).toContain("Ollama");
      expect(terms).toMatch(/handoff/i);
      for (const retired of [
        "Grimodex Scan",
        "Hosted AI",
        "Cloudflare R2",
        "Cloudflare D1",
        "Cloudflare Access",
        "OpenRouter",
        "public report",
        "公開レポート",
      ]) {
        expect(terms).not.toContain(retired);
      }
    }
  });
});
