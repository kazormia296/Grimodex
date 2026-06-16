// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LinterCategory } from "./LinterCategory";

// t() returns the key so we can assert on i18n keys directly.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Heavy sibling tabs are not under test here.
vi.mock("@/features/lint/TermDictionaryTab", () => ({
  TermDictionaryTab: () => null,
}));
vi.mock("@/features/lint/LinterIgnoreListTab", () => ({
  LinterIgnoreListTab: () => null,
}));

const h = vi.hoisted(() => {
  const effective = {
    enabled: true,
    rules: {
      "ja/consecutive-punct": { enabled: true },
      "en/straight-quotes": { enabled: true },
    },
  };
  const storeState = {
    getEffective: () => effective,
    setLinterEnabled: vi.fn(),
    setRule: vi.fn(),
    resetRule: vi.fn(),
    resetLanguage: vi.fn(),
    resetAll: vi.fn(),
  };
  return { storeState };
});

vi.mock("@/features/lint/lintConfigStore", () => ({
  useLintConfigStore: (sel: (s: unknown) => unknown) => sel(h.storeState),
  BUILTIN_DEFAULT_CONFIG: {
    rules: {
      "ja/consecutive-punct": { enabled: true },
      "en/straight-quotes": { enabled: true },
    },
  },
}));

function setProjectLanguage(lang: "ja" | "en") {
  document.documentElement.lang = lang;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.documentElement.lang = "";
});

describe("LinterCategory — アクティブ執筆言語に応じたルールセット並び", () => {
  it("英語プロジェクトでは英語ルールセクションが日本語ルールより先に描画される", () => {
    setProjectLanguage("en");
    render(<LinterCategory />);

    const en = screen.getByText("settings.linter.langRulesEn");
    const ja = screen.getByText("settings.linter.langRulesJa");
    // DOM 順序: en が ja より前。
    expect(
      en.compareDocumentPosition(ja) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("英語プロジェクトでは非アクティブな日本語ルールは折りたたまれ既定で非表示", () => {
    setProjectLanguage("en");
    render(<LinterCategory />);

    // アクティブ言語(英語)のルール行は見える。
    expect(screen.getByText("en/straight-quotes")).toBeTruthy();
    // 非アクティブ言語(日本語)のルール行は折りたたまれて描画されない。
    expect(screen.queryByText("ja/consecutive-punct")).toBeNull();
  });

  it("非アクティブ言語セクションに『適用外』の注記が表示される", () => {
    setProjectLanguage("en");
    render(<LinterCategory />);
    expect(screen.getByText("settings.linter.langNotApplied")).toBeTruthy();
  });

  it("日本語プロジェクトでは日本語ルールが先・英語ルールは折りたたみ", () => {
    setProjectLanguage("ja");
    render(<LinterCategory />);

    const en = screen.getByText("settings.linter.langRulesEn");
    const ja = screen.getByText("settings.linter.langRulesJa");
    expect(
      ja.compareDocumentPosition(en) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(screen.getByText("ja/consecutive-punct")).toBeTruthy();
    expect(screen.queryByText("en/straight-quotes")).toBeNull();
  });

  it("『ルールを表示』を押すと非アクティブ言語のルールが展開される", () => {
    setProjectLanguage("en");
    render(<LinterCategory />);

    // 折りたたみ状態では日本語ルールは非表示。
    expect(screen.queryByText("ja/consecutive-punct")).toBeNull();
    // 展開トグルを押す。
    fireEvent.click(screen.getByText("settings.linter.expandLangRules"));
    // 日本語ルール行が現れ、ボタンは『隠す』に変わる。
    expect(screen.getByText("ja/consecutive-punct")).toBeTruthy();
    expect(screen.getByText("settings.linter.collapseLangRules")).toBeTruthy();
  });
});
