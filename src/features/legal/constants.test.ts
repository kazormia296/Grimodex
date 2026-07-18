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

  it("ships a localized privacy notice referenced by the AI consent disclosures", () => {
    for (const locale of ["ja", "en"]) {
      const privacy = readFileSync(
        resolve(REPO_ROOT, `public/PRIVACY_${locale}.md`),
        "utf8",
      );
      expect(privacy).toContain("GDX-AI-CONSENT-001");
    }
  });
});
