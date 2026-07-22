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

  it("exposes full 0-100 ranges for intensity, speed and paper opacity", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    for (const label of [
      "settings.editor.zenOpacity",
      "settings.editor.zenSpeed",
      "editor.background.paperOpacity",
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

  it("exposes a smooth paper edge fade without blur or halftone controls", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    expect(
      screen.getByLabelText("editor.background.paperEdgeFade"),
    ).toHaveAttribute("max", "30");
    expect(screen.queryByLabelText("editor.background.paperBlur")).toBeNull();
    expect(
      screen.queryByLabelText("editor.background.paperHalftoneStrength"),
    ).toBeNull();
  });

  it("applies intensity, speed and paper opacity changes immediately", () => {
    render(<BackgroundStudio open onClose={vi.fn()} />);

    const changes = [
      ["settings.editor.zenOpacity", "editor.zenBackground.opacity"],
      ["settings.editor.zenSpeed", "editor.zenBackground.speedPercent"],
      ["editor.background.paperOpacity", "editor.zenBackground.paperOpacity"],
    ] as const;

    for (const [label, settingKey] of changes) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "100" },
      });
      expect(useSettingsStore.getState().cache[settingKey]).toBe("100");
    }
  });

  it("does not render when closed", () => {
    render(<BackgroundStudio open={false} onClose={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
