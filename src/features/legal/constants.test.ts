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
    const expectedDeletionCopy = {
      ja: [
        "バージョン: v1.1",
        "原稿と Scan データを削除",
        "すでに Hosted Editor またはローカル版 Grimodex へ取り込んだコピーは削除されません",
      ],
      en: [
        "Version: v1.1",
        "Delete manuscript and Scan data",
        "Copies already imported into Hosted Editor or the local Grimodex application are not deleted",
      ],
    } as const;
    for (const locale of ["ja", "en"] as const) {
      const privacy = readFileSync(
        resolve(REPO_ROOT, `public/PRIVACY_${locale}.md`),
        "utf8",
      );
      expect(privacy).toContain("GDX-AI-CONSENT-001");
      for (const expected of expectedDeletionCopy[locale]) {
        expect(privacy).toContain(expected);
      }
    }
  });
});
