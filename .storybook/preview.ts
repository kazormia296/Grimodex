import type { Preview } from "@storybook/react-vite";
import "../src/index.css";
import { ensureLocale } from "../src/lib/i18n";

// 製品は英語の辞書を後から読む。story は言語を直接切り替えるので先に入れておく。
void ensureLocale("en");

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
