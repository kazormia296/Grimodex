import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { BackgroundStudio } from "./BackgroundStudio";

describe("BackgroundStudio (real Chromium)", () => {
  beforeEach(() => {
    const state = useSettingsStore.getState();
    for (const timer of state._timers.values()) clearTimeout(timer);
    useSettingsStore.setState({
      cache: { ...DEFAULT_SETTINGS },
      layers: { legacy: {}, project: {}, global: {} },
      _timers: new Map(),
      _pending: new Map(),
    });
  });

  afterEach(() => {
    const state = useSettingsStore.getState();
    for (const timer of state._timers.values()) clearTimeout(timer);
    useSettingsStore.setState({ _timers: new Map(), _pending: new Map() });
    cleanup();
  });

  it("portals the palette out of the clipped studio and keeps it in the viewport", async () => {
    const { container } = render(<BackgroundStudio open onClose={vi.fn()} />);

    const paletteMode = Array.from(
      container.querySelectorAll<HTMLSelectElement>("select"),
    ).find((select) => select.querySelector('option[value="custom"]'));
    expect(paletteMode).toBeDefined();

    fireEvent.change(paletteMode!, {
      target: { value: "custom" },
    });
    fireEvent.click(screen.getAllByTestId("setting-color-input-trigger")[0]);

    const palette = await waitFor(() =>
      screen.getByTestId("setting-color-input-palette"),
    );
    const studio = container.querySelector<HTMLElement>(
      "[data-background-studio]",
    );

    expect(studio).not.toBeNull();
    expect(studio?.contains(palette)).toBe(false);
    expect(document.body.contains(palette)).toBe(true);
    expect(getComputedStyle(palette).zIndex).toBe("100");

    await waitFor(() => {
      const bounds = palette.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.left).toBeGreaterThanOrEqual(12);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 12);
      expect(bounds.top).toBeGreaterThanOrEqual(12);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 12);
    });
  });

  it.each([
    { label: "normal", zenMode: false, expectedTop: 48 },
    { label: "Zen", zenMode: true, expectedTop: 12 },
  ])(
    "keeps the $label studio and its final section inside the viewport",
    async ({ zenMode, expectedTop }) => {
      const { container } = render(
        <BackgroundStudio open onClose={vi.fn()} zenMode={zenMode} />,
      );
      const studio = container.querySelector<HTMLElement>(
        "[data-background-studio]",
      );
      const scrollRegion =
        studio?.querySelector<HTMLElement>(".overflow-y-auto");
      const sections = studio?.querySelectorAll<HTMLElement>("details");
      const finalSection = sections?.item((sections?.length ?? 1) - 1);

      expect(studio).not.toBeNull();
      expect(scrollRegion).not.toBeNull();
      expect(finalSection).not.toBeNull();

      await waitFor(() => {
        const bounds = studio!.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThan(0);
        expect(bounds.top).toBeCloseTo(expectedTop, 0);
        expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 12);
      });

      expect(scrollRegion!.scrollHeight).toBeGreaterThan(
        scrollRegion!.clientHeight,
      );
      scrollRegion!.scrollTop = scrollRegion!.scrollHeight;
      fireEvent.scroll(scrollRegion!);

      await waitFor(() => {
        const scrollBounds = scrollRegion!.getBoundingClientRect();
        const finalBounds = finalSection!.getBoundingClientRect();
        expect(scrollRegion!.scrollTop).toBeGreaterThan(0);
        expect(finalBounds.bottom).toBeLessThanOrEqual(scrollBounds.bottom + 1);
        expect(finalBounds.bottom).toBeGreaterThan(scrollBounds.top);
      });
    },
  );
});
