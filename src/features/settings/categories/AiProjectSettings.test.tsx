// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeCapabilitiesProvider } from "@/runtime/runtimeCapabilitiesContext";
import { AiProjectSettings } from "./AiProjectSettings";

const settings = vi.hoisted(() => ({
  values: {
    "ai.autoAcceptBodyProposals": false,
    "ai.semanticRecall": true,
    "ai.hybridRecall": true,
    "ai.chatRecall": true,
    "ai.semanticReranker": false,
  } as Record<string, boolean>,
  setters: new Map<string, ReturnType<typeof vi.fn>>(),
}));
const projectState = vi.hoisted(() => ({ language: "ja" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    project: {
      language: projectState.language,
      aiPolicy: null,
      outline: null,
      targetReaders: null,
      styleGuide: null,
      aiInstructions: null,
    },
    isLoading: false,
    updateField: vi.fn(),
  }),
}));

vi.mock("../useSettingControl", () => ({
  useSettingBoolean: (key: string, fallback: boolean) => {
    let setter = settings.setters.get(key);
    if (!setter) {
      setter = vi.fn();
      settings.setters.set(key, setter);
    }
    return {
      value: settings.values[key] ?? fallback,
      setValue: setter,
    };
  },
}));

beforeEach(() => {
  settings.values["ai.semanticRecall"] = true;
  settings.values["ai.hybridRecall"] = true;
  settings.values["ai.semanticReranker"] = false;
  settings.setters.clear();
  projectState.language = "ja";
});

function renderSettings(target: "electron" | "web" = "electron") {
  return render(
    <RuntimeCapabilitiesProvider target={target}>
      <AiProjectSettings />
    </RuntimeCapabilitiesProvider>,
  );
}

function rerankerCheckbox(container: HTMLElement): HTMLInputElement {
  const label = screen.getByText("Semantic reranking（実験的）");
  const row = label.closest("[data-setting-row]");
  const checkbox = row?.querySelector('input[type="checkbox"]');
  if (!(checkbox instanceof HTMLInputElement)) {
    throw new Error("semantic reranker checkbox not found");
  }
  expect(container.contains(checkbox)).toBe(true);
  return checkbox;
}

describe("AiProjectSettings semantic reranker", () => {
  it("renders an opt-in toggle and persists explicit enablement", () => {
    const { container } = renderSettings();
    const checkbox = rerankerCheckbox(container);

    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(
      screen.getByText(
        "関連シーン候補をローカルモデルで再順位付けします。処理に時間がかかる場合は従来の検索結果を使用します。",
      ),
    ).toBeTruthy();

    fireEvent.click(checkbox);
    expect(settings.setters.get("ai.semanticReranker")).toHaveBeenCalledWith(
      true,
    );
  });

  it("is inert unless semantic and hybrid recall are both enabled", () => {
    settings.values["ai.hybridRecall"] = false;
    const { container } = renderSettings();

    expect(rerankerCheckbox(container).disabled).toBe(true);
  });

  it.each(["zh", "ko"])(
    "is disabled for unsupported project language %s",
    (language) => {
      projectState.language = language;
      const { container } = renderSettings();

      expect(rerankerCheckbox(container).disabled).toBe(true);
      expect(
        screen.getByText(
          "現在は日本語・英語のデスクトップ版でのみ利用できます。",
        ),
      ).toBeTruthy();
    },
  );

  it("is disabled in the Web Editor even for a supported language", () => {
    const { container } = renderSettings("web");

    expect(rerankerCheckbox(container).disabled).toBe(true);
    expect(
      screen.getByText(
        "現在は日本語・英語のデスクトップ版でのみ利用できます。",
      ),
    ).toBeTruthy();
  });
});
