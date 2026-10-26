// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "@/features/chat/store";
import Nir1LocalDisclosure from "./Nir1LocalDisclosure";
import { NIR1_LOCAL_GENERATION_TRANSLATIONS } from "./nir1LocalGenerationTranslations";

// DD-1c (DR-DD1C-9; K5/3 開示の試験 (1), (2), (6)): each placement draws the
// items it needs, from the structured list, in both languages.

function itemsOf(root: Element): string[] {
  return [...root.querySelectorAll("[data-nir1-local-disclosure-item]")].map(
    (item) => item.getAttribute("data-nir1-local-disclosure-item") ?? "",
  );
}

function setRoute(baseUrl: string) {
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: "openai-compatible",
      model: "local-model",
      openaiCompatibleEndpoints: [{ id: "local-1", label: "", baseUrl }],
      activeOpenaiCompatibleEndpointId: "local-1",
    },
  } as never);
}

beforeEach(() => setRoute("http://[::1]:11434/v1"));
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ja");
});

describe.each(["ja", "en"] as const)("the %s disclosure", (language) => {
  const strings = NIR1_LOCAL_GENERATION_TRANSLATIONS[language];
  beforeEach(async () => {
    await i18n.changeLanguage(language);
  });

  it("draws every item with the route at placement 1", () => {
    render(<Nir1LocalDisclosure placement={1} />);
    const root = screen.getByTestId("nir1-local-disclosure");
    expect(itemsOf(root)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    for (const item of ["1", "4", "9"] as const) {
      expect(root.textContent).toContain(strings.disclosure.items[item].body);
    }
    expect(screen.getByTestId("nir1-local-route").textContent).toContain(
      "http://[::1]:11434/v1/chat/completions",
    );
    expect(screen.getByTestId("nir1-local-route").textContent).toContain(
      "local-model",
    );
  });

  it("draws items 3, 4 and 9 at placement 2, with a step to all", () => {
    render(<Nir1LocalDisclosure placement={2} />);
    const root = screen.getByTestId("nir1-local-disclosure");
    expect(itemsOf(root)).toEqual(["3", "4", "9"]);
    expect(screen.queryByTestId("nir1-local-route")).toBeNull();
    fireEvent.click(screen.getByText(strings.disclosure.showAll));
    expect(itemsOf(root)).toHaveLength(9);
  });

  it("explains why localhost cannot be used at placement 3", () => {
    setRoute("http://localhost:11434/v1");
    render(<Nir1LocalDisclosure placement={3} />);
    const route = screen.getByTestId("nir1-local-route");
    expect(route.getAttribute("data-nir1-local-route")).toBe("unusable");
    expect(route.textContent).toContain(strings.route.unusable["not-loopback"]);
  });

  it("reaches the summary of items 3, 4 and 6 from the restricted status (placement 5)", async () => {
    render(<Nir1LocalDisclosure placement={5} />);
    expect(screen.queryByTestId("nir1-local-disclosure")).toBeNull();
    fireEvent.click(
      screen.getByTestId("nir1-local-restricted-summary-trigger"),
    );
    const root = await screen.findByTestId("nir1-local-disclosure");
    expect(itemsOf(root)).toEqual(["3", "4", "6"]);
    for (const item of ["3", "4", "6"] as const) {
      expect(root.textContent).toContain(
        strings.disclosure.items[item].summary,
      );
    }
    fireEvent.click(screen.getByText(strings.disclosure.showAll));
    expect(itemsOf(root)).toHaveLength(9);
  });
});
