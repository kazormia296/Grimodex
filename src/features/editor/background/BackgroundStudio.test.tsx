// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { BackgroundStudio } from "./BackgroundStudio";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("BackgroundStudio", () => {
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
  });

  it("edits the real editor background without a separate preview canvas", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    expect(
      screen.getByRole("dialog", { name: "editor.background.title" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("zen-background-preview")).toBeNull();

    const shader = screen.getByLabelText("settings.editor.zenBackgroundShader");
    expect(within(shader).getAllByRole("option")).toHaveLength(29);
  });

  it("exposes full 0-100 ranges for intensity and speed", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    for (const label of [
      "settings.editor.zenOpacity",
      "settings.editor.zenSpeed",
    ]) {
      const slider = screen.getByLabelText(label);
      expect(slider).toHaveAttribute("min", "0");
      expect(slider).toHaveAttribute("max", "100");
    }
  });

  it("can disable the ambient background without losing its configuration", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    const enabled = screen.getByRole("switch", {
      name: "editor.background.enabled",
    });
    expect(enabled).toBeChecked();

    fireEvent.click(enabled);

    expect(
      useSettingsStore.getState().cache["editor.zenBackground.enabled"],
    ).toBe("false");
    expect(
      screen.getByLabelText("settings.editor.zenBackgroundShader"),
    ).toHaveValue("mesh-gradient");
  });

  it("does not expose paper paint, blur or halftone controls", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    expect(
      screen.queryByLabelText("editor.background.paperOpacity"),
    ).toBeNull();
    expect(
      screen.queryByLabelText("editor.background.paperEdgeFade"),
    ).toBeNull();
    expect(screen.queryByLabelText("editor.background.paperBlur")).toBeNull();
    expect(
      screen.queryByLabelText("editor.background.paperHalftoneStrength"),
    ).toBeNull();
  });

  it("offers automatic readability protection with a 4.5-to-7 contrast range", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    const mode = screen.getByLabelText("settings.editor.zenContrastGuard");
    expect(within(mode).getAllByRole("option")).toHaveLength(2);
    expect(mode).toHaveValue("auto");

    const strength = screen.getByLabelText(
      "settings.editor.zenContrastGuardStrength",
    );
    expect(strength).toHaveAttribute("min", "0");
    expect(strength).toHaveAttribute("max", "1");
    expect(strength).not.toBeDisabled();

    const toolMix = screen.getByLabelText(
      "settings.editor.zenContrastGuardToolMix",
    );
    expect(toolMix).toHaveAttribute("min", "0");
    expect(toolMix).toHaveAttribute("max", "0.5");
    expect(toolMix).toHaveAttribute("step", "0.01");
    expect(toolMix).toHaveValue("0.3");
    expect(toolMix).not.toBeDisabled();

    fireEvent.change(toolMix, { target: { value: "0.43" } });
    expect(
      useSettingsStore.getState().cache[
        "editor.zenBackground.contrastGuard.toolMix"
      ],
    ).toBe("0.43");

    fireEvent.change(mode, { target: { value: "none" } });

    expect(
      useSettingsStore.getState().cache[
        "editor.zenBackground.contrastGuard.mode"
      ],
    ).toBe("none");
    expect(strength).toBeDisabled();
    expect(toolMix).toBeDisabled();
  });

  it("adjusts the shared Fluid Glass effect from the live studio", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    const enabled = screen.getByRole("switch", {
      name: "settings.editor.zenGlassEnabled",
    });
    expect(enabled).toBeChecked();

    const controls = [
      ["settings.editor.zenGlassBlur", "0", "40"],
      ["settings.editor.zenGlassRefraction", "0", "24"],
      ["settings.editor.zenGlassSaturation", "0", "2"],
      ["settings.editor.zenGlassShine", "0", "1"],
    ] as const;
    for (const [label, min, max] of controls) {
      const slider = screen.getByLabelText(label);
      expect(slider).toHaveAttribute("min", min);
      expect(slider).toHaveAttribute("max", max);
      expect(slider).not.toBeDisabled();
    }

    fireEvent.change(screen.getByLabelText("settings.editor.zenGlassBlur"), {
      target: { value: "32" },
    });
    expect(
      useSettingsStore.getState().cache["editor.zenBackground.glass.blur"],
    ).toBe("32");

    fireEvent.click(enabled);
    expect(
      useSettingsStore.getState().cache["editor.zenBackground.glass.enabled"],
    ).toBe("false");
    for (const [label] of controls) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
  });

  it("applies intensity and speed changes immediately", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    const changes = [
      ["settings.editor.zenOpacity", "editor.zenBackground.opacity"],
      ["settings.editor.zenSpeed", "editor.zenBackground.speedPercent"],
    ] as const;

    for (const [label, settingKey] of changes) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "100" },
      });
      expect(useSettingsStore.getState().cache[settingKey]).toBe("100");
    }
  });

  it("opens custom color palettes in a viewport-aware portal", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("settings.editor.zenPalette"), {
      target: { value: "custom" },
    });

    const [trigger] = screen.getAllByTestId("setting-color-input-trigger");
    fireEvent.click(trigger);

    const palette = screen.getByTestId("setting-color-input-palette");
    expect(palette.closest("[data-background-studio]")).toBeNull();
    expect(document.querySelector('input[type="color"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "#F43F5E" }));
    expect(
      useSettingsStore.getState().cache["editor.zenBackground.color1"],
    ).toBe("#F43F5E");
    expect(screen.queryByTestId("setting-color-input-palette")).toBeNull();
  });

  it("accepts arbitrary custom colors as HEX values", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("settings.editor.zenPalette"), {
      target: { value: "custom" },
    });
    fireEvent.click(screen.getAllByTestId("setting-color-input-trigger")[0]);

    const hex = screen.getByLabelText("HEX");
    fireEvent.change(hex, { target: { value: "#12ab34" } });

    expect(
      useSettingsStore.getState().cache["editor.zenBackground.color1"],
    ).toBe("#12AB34");

    fireEvent.keyDown(hex, { key: "Enter" });
    expect(screen.queryByTestId("setting-color-input-palette")).toBeNull();
  });

  it("does not render when closed", () => {
    render(<BackgroundStudio open={false} onClose={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
