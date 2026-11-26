import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import i18next from "@/lib/i18n";
import { OUTPUT_TRUNCATION_TRANSLATIONS } from "./outputTruncationTranslations";

// i18next は足した bundle を読み込んだ JSON の object に merge するので、file を直接読む。
const chatKeys = (language: string) =>
  Object.keys(
    (
      JSON.parse(
        readFileSync(path.resolve("src/locales", `${language}.json`), "utf8"),
      ) as { chat: Record<string, unknown> }
    ).chat,
  );

describe("出力の打ち切りの文", () => {
  it.each(["ja", "en"] as const)(
    "%s の起動時の辞書に入れず、登録すると引ける",
    (language) => {
      const strings = OUTPUT_TRUNCATION_TRANSLATIONS[language].chat;
      for (const [key, value] of Object.entries(strings)) {
        expect(chatKeys(language)).not.toContain(key);
        expect(
          i18next.getResource(language, "translation", `chat.${key}`),
        ).toBe(value);
      }
    },
  );
});
