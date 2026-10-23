import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-vitest"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal: async (config) => {
    config.resolve ??= {};
    // Storybook 10.6 以降は alias を配列で渡す。object／array のどちらでも "@" を足せるよう
    // 配列へ正規化する（object を展開すると配列が壊れて build が失敗する）。
    const existing = config.resolve.alias;
    const entries = Array.isArray(existing)
      ? existing
      : Object.entries(existing ?? {}).map(([find, replacement]) => ({
          find,
          replacement,
        }));
    config.resolve.alias = [
      ...entries.filter((entry) => entry.find !== "@"),
      { find: "@", replacement: path.resolve(__dirname, "../src") },
    ];
    return config;
  },
};

export default config;
