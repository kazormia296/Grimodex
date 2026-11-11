import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "@/locales/ja.json";
import { debugLog, errorDetail, setRootCauseRefusalText } from "./debugLog";

// 起動時に読むのは既定の日本語だけ。英語の辞書（約 290 KB）は英語の画面を使う人だけが
// `ensureLocale` で後から読む。読み終わるまでは fallbackLng の日本語が出る。
i18next.use(initReactI18next).init({
  lng: "ja",
  fallbackLng: "ja",
  resources: {
    ja: { translation: ja },
  },
  interpolation: {
    escapeValue: false,
  },
});

// `rootCause` shows a D2a refusal as this generic text (DR-DA2B-R5).
setRootCauseRefusalText(() => i18next.t("common.error"));

let enLocaleLoad: Promise<void> | null = null;

/**
 * その言語の辞書が i18next に入っていることを保証する。日本語は起動時に入っているので
 * 何もしない。
 *
 * feature ごとの追加翻訳（`addResourceBundle`）が先に英語へ入っていることがあるので、
 * 辞書は既存の値を置き換えない deep merge で足す。登録の順が変わっても結果が同じに
 * なることは i18n.localeOrder.test.ts が固定する。
 */
export function ensureLocale(language: string): Promise<void> {
  if (!language.startsWith("en")) return Promise.resolve();
  if (!enLocaleLoad) {
    const load = import("@/locales/en.json").then((module) => {
      i18next.addResourceBundle(
        "en",
        "translation",
        module.default,
        true,
        false,
      );
    });
    enLocaleLoad = load;
    // 読み込みに失敗したら次の呼び出しでやり直す。
    load.catch(() => {
      if (enLocaleLoad === load) enLocaleLoad = null;
    });
  }
  return enLocaleLoad;
}

let languageRequest = 0;

/**
 * 画面の言語を切り替える。辞書を読み終えてから切り替えるので、切替の再描画の時点で
 * 文言が揃っている。読み込み中に別の言語が要求されたら、後の要求だけを適用する。
 * 辞書を読めなかったときも切り替える（fallbackLng の日本語が出る）。
 */
export async function changeUiLanguage(language: string): Promise<void> {
  const request = ++languageRequest;
  try {
    await ensureLocale(language);
  } catch (error) {
    debugLog.error("i18n", "failed to load locale", errorDetail(error));
  }
  if (request !== languageRequest) return;
  if (i18next.language !== language) await i18next.changeLanguage(language);
}

export default i18next;
