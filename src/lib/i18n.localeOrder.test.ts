import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 英語の辞書は起動時に読まず、`ensureLocale("en")` で後から足す。feature ごとの追加翻訳
 * （`addResourceBundle`）は辞書より先にも後にも入りうるので、どちらの順でも英語の
 * 文言が同じになることを固定する。
 */
const FEATURE_TRANSLATIONS: ReadonlyArray<{
  file: string;
  install: () => Promise<void>;
}> = [
  {
    file: "features/import/chatImportNotice.ts",
    install: async () =>
      (
        await import("@/features/import/chatImportNotice")
      ).ensureChatImportNotice(),
  },
  {
    file: "features/scene-scope-default/sceneScopeDefaultTranslations.ts",
    install: async () =>
      (
        await import("@/features/scene-scope-default/sceneScopeDefaultTranslations")
      ).ensureSceneScopeDefaultTranslations(),
  },
  {
    file: "features/related-scenes/nir1GraphTranslations.ts",
    install: async () =>
      (
        await import("@/features/related-scenes/nir1GraphTranslations")
      ).ensureNir1GraphTranslations(),
  },
  {
    file: "features/profile-egress/profileEgressAiStopText.ts",
    install: async () =>
      (
        await import("@/features/profile-egress/profileEgressAiStopText")
      ).ensureProfileEgressAiStopTranslations(),
  },
  {
    file: "features/profile-egress/profileEgressTranslations.ts",
    install: async () =>
      (
        await import("@/features/profile-egress/profileEgressTranslations")
      ).ensureProfileEgressTranslations(),
  },
  {
    file: "locales/liveReader.ts",
    install: async () =>
      (await import("@/locales/liveReader")).ensureLiveReaderTranslations(),
  },
  {
    file: "features/chat/nir1/nir1LocalGenerationTranslations.ts",
    install: async () =>
      (
        await import("@/features/chat/nir1/nir1LocalGenerationTranslations")
      ).ensureNir1LocalGenerationTranslations(),
  },
  {
    file: "features/editor/sceneMeta/bodyDeclaration/bodyDeclarationTranslations.ts",
    install: async () =>
      (
        await import("@/features/editor/sceneMeta/bodyDeclaration/bodyDeclarationTranslations")
      ).ensureBodyDeclarationTranslations(),
  },
];

const SRC_ROOT = path.resolve(__dirname, "..");

function sourceFilesCallingAddResourceBundle(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (
        /\.tsx?$/u.test(entry.name) &&
        !/\.(test|stories)\.tsx?$/u.test(entry.name) &&
        readFileSync(absolute, "utf8").includes("addResourceBundle(")
      ) {
        found.push(path.relative(SRC_ROOT, absolute).split(path.sep).join("/"));
      }
    }
  };
  walk(SRC_ROOT);
  return found.sort();
}

async function englishResourcesAfter(
  order: "locale-first" | "features-first",
): Promise<unknown> {
  vi.resetModules();
  const { default: i18next, ensureLocale } = await import("@/lib/i18n");
  i18next.removeResourceBundle("en", "translation");
  if (order === "locale-first") await ensureLocale("en");
  for (const feature of FEATURE_TRANSLATIONS) await feature.install();
  if (order === "features-first") await ensureLocale("en");
  return structuredClone(i18next.getResourceBundle("en", "translation"));
}

describe("英語の辞書と feature の追加翻訳の登録順", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("追加翻訳を登録する module をすべて把握している", () => {
    expect(sourceFilesCallingAddResourceBundle()).toEqual(
      [
        ...FEATURE_TRANSLATIONS.map((feature) => feature.file),
        "lib/i18n.ts",
      ].sort(),
    );
  });

  it("辞書が先でも後でも、英語の文言は同じになる", async () => {
    const localeFirst = await englishResourcesAfter("locale-first");
    const featuresFirst = await englishResourcesAfter("features-first");
    expect(featuresFirst).toEqual(localeFirst);
  });

  it("日本語では辞書を読みにいかない", async () => {
    const { default: i18next, ensureLocale } = await import("@/lib/i18n");
    i18next.removeResourceBundle("en", "translation");
    await ensureLocale("ja");
    expect(i18next.hasResourceBundle("en", "translation")).toBe(false);
  });
});

describe("changeUiLanguage", () => {
  it("辞書を入れてから切り替え、読み込み中の古い要求は適用しない", async () => {
    vi.resetModules();
    const { default: i18next, changeUiLanguage } = await import("@/lib/i18n");
    i18next.removeResourceBundle("en", "translation");
    const toEnglish = changeUiLanguage("en");
    const backToJapanese = changeUiLanguage("ja");
    await Promise.all([toEnglish, backToJapanese]);
    expect(i18next.language).toBe("ja");

    await changeUiLanguage("en");
    expect(i18next.language).toBe("en");
    expect(i18next.hasResourceBundle("en", "translation")).toBe(true);
    expect(i18next.t("common.error")).toBe(
      i18next.getResource("en", "translation", "common.error"),
    );
    await changeUiLanguage("ja");
  });

  it("辞書を読めなかったときも切り替え、裏で読み直して、読めたら描き直す", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const {
        default: i18next,
        changeUiLanguage,
        uiLanguageSettled,
      } = await import("@/lib/i18n");
      i18next.removeResourceBundle("en", "translation");
      await i18next.changeLanguage("ja");
      const add = vi
        .spyOn(i18next, "addResourceBundle")
        .mockImplementationOnce(() => {
          throw new Error("chunk load failed");
        });
      const languageChanged = vi.fn();
      i18next.on("languageChanged", languageChanged);

      await changeUiLanguage("en");
      await uiLanguageSettled();
      expect(i18next.language).toBe("en");
      expect(i18next.hasResourceBundle("en", "translation")).toBe(false);
      expect(languageChanged).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(i18next.hasResourceBundle("en", "translation")).toBe(true),
      );
      await vi.waitFor(() => expect(languageChanged).toHaveBeenCalledTimes(2));
      expect(i18next.language).toBe("en");

      i18next.off("languageChanged", languageChanged);
      add.mockRestore();
      await changeUiLanguage("ja");
    } finally {
      vi.useRealTimers();
    }
  });
});
