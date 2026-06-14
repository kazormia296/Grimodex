import { describe, expect, it } from "vitest";
import {
  SCREENSHOT_SEED_CONTENT,
  type ScreenshotSceneContent,
} from "./screenshotSeedContent";
import { SCREENSHOT_LANGUAGES } from "./screenshotMode";

/** proseDoc が生成する ProseMirror doc の content.size（段落ごとに +2）。 */
function pmDocSize(body: string[]): number {
  return body.reduce((n, p) => n + p.length + 2, 0);
}

describe("SCREENSHOT_SEED_CONTENT", () => {
  it("defines content for every supported screenshot language", () => {
    for (const lang of SCREENSHOT_LANGUAGES) {
      expect(SCREENSHOT_SEED_CONTENT[lang]).toBeTruthy();
    }
  });

  for (const lang of SCREENSHOT_LANGUAGES) {
    describe(`[${lang}]`, () => {
      const c = SCREENSHOT_SEED_CONTENT[lang];

      it("fills every translatable string", () => {
        const required = [
          c.project.title,
          c.project.genre,
          c.chapter.title,
          c.scenes.scene1.title,
          c.scenes.scene1.synopsis,
          c.codex.akane.name,
          c.codex.akahimo.name,
          c.snippets.reunion.title,
          c.map.frameTitle,
          c.foreshadows.warmth.title,
          c.chat.sessionTitle,
          c.lint.lastSceneText,
        ];
        for (const value of required) {
          expect(value.trim().length).toBeGreaterThan(0);
        }
      });

      it("keeps scene char counts as positive integers", () => {
        for (const scene of Object.values(
          c.scenes,
        ) as ScreenshotSceneContent[]) {
          expect(Number.isInteger(scene.charCount)).toBe(true);
          expect(scene.charCount).toBeGreaterThan(0);
          expect(scene.body.length).toBeGreaterThan(0);
        }
      });

      it("anchors annotations on exact substrings of scene 1", () => {
        const body = c.scenes.scene1.body.join("\n");
        expect(body).toContain(c.annotations.compassDry.textSnapshot);
        expect(body).toContain(c.annotations.compassDry.foundText);
        expect(body).toContain(c.annotations.foreignMemory.textSnapshot);
        expect(body).toContain(c.annotations.foreignMemory.foundText);
      });

      it("keeps authorship spans monotonic and within the scene doc", () => {
        const { scene1, scene2, scene3 } = c.authorship;
        expect(scene1.humanTo).toBeLessThan(scene1.aiTo);
        expect(scene1.aiTo).toBeLessThan(scene1.unknownTo);
        expect(scene1.unknownTo).toBeLessThanOrEqual(
          pmDocSize(c.scenes.scene1.body),
        );
        expect(scene2.humanTo).toBeLessThanOrEqual(
          pmDocSize(c.scenes.scene2.body),
        );
        expect(scene3.aiTo).toBeLessThanOrEqual(
          pmDocSize(c.scenes.scene3.body),
        );
      });

      it("keeps foreshadow setup ranges ordered and within scene 1", () => {
        const docSize = pmDocSize(c.scenes.scene1.body);
        for (const setup of [
          c.foreshadows.setupWarmth,
          c.foreshadows.setupLock,
        ]) {
          expect(setup.fromPos).toBeLessThan(setup.toPos);
          expect(setup.toPos).toBeLessThanOrEqual(docSize);
        }
      });

      it("keeps lint diagnostic ranges ordered and within the scene 1 doc", () => {
        // lint range は校閲対象（scene-1 本文）上のアンカー。lastSceneText は
        // 別途保持する圧縮テキストなので、上限は scene-1 の doc サイズで見る。
        const docSize = pmDocSize(c.scenes.scene1.body);
        for (const diag of [c.lint.diag1, c.lint.diag2]) {
          expect(diag.rangeStart).toBeLessThan(diag.rangeEnd);
          expect(diag.rangeEnd).toBeLessThanOrEqual(docSize);
        }
      });

      it("tags lint diagnostics with the matching language prefix", () => {
        expect(c.lint.diag1.ruleId.startsWith(`${lang}/`)).toBe(true);
        expect(c.lint.diag2.ruleId.startsWith(`${lang}/`)).toBe(true);
      });
    });
  }
});
