import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "@/locales/ja.json";
import en from "@/locales/en.json";

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

export default i18next;
