import { describe, expect, it } from "vitest";
import i18next from "@/lib/i18n";
import { ensureLiveReaderTranslations } from "./liveReader";

describe("live reader translations", () => {
  it("registers both locales without replacing existing resources", () => {
    const existing = i18next.getResource("ja", "translation", "common.close");

    ensureLiveReaderTranslations();

    expect(
      i18next.getResource("ja", "translation", "settings.ai.liveReader.title"),
    ).toBe("リアルタイム読者コメント");
    expect(
      i18next.getResource("en", "translation", "kouetsu.comments.sortNewest"),
    ).toBe("Newest first");
    expect(i18next.getResource("ja", "translation", "common.close")).toBe(
      existing,
    );
  });
});
