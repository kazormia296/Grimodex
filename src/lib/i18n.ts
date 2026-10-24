import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "@/locales/ja.json";
import en from "@/locales/en.json";
import { setRootCauseRefusalText } from "./debugLog";

i18next.use(initReactI18next).init({
  lng: "ja",
  fallbackLng: "ja",
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  interpolation: {
    escapeValue: false,
  },
});

// `rootCause` shows a D2a refusal as this generic text (DR-DA2B-R5).
setRootCauseRefusalText(() => i18next.t("common.error"));

export default i18next;
