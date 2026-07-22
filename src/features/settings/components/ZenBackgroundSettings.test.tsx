// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import { useSettingsStore } from "../settingsStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/editor/zen/ZenShaderSurface", () => ({
  ZenShaderSurface: () => <div data-zen-background-preview />,
}));

import { ZenBackgroundSettings } from "./ZenBackgroundSettings";

function setCache(overrides: Record<string, string> = {}) {
  useSettingsStore.setState({
    cache: { ...DEFAULT_SETTINGS, ...overrides },
  });
}

describe("ZenBackgroundSettings", () => {
  beforeEach(() => setCache());

  it("shows a static live preview plus common and Mesh Gradient controls", () => {
    render(<ZenBackgroundSettings />);

    expect(screen.getByTestId("zen-background-preview")).toBeInTheDocument();
    expect(
      screen.getByLabelText("settings.editor.zenBackgroundShader"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("settings.editor.zenSpeed"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("settings.editor.zenScale"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("settings.editor.zenMeshDistortion"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("settings.editor.zenGrainShape"),
    ).not.toBeInTheDocument();
  });

  it("switches to the selected shader's own Paper props", () => {
    setCache({ "editor.zenBackground.shader": "grain-gradient" });
    const { rerender } = render(<ZenBackgroundSettings />);

    expect(
      screen.getByLabelText("settings.editor.zenGrainShape"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("settings.editor.zenGrainSoftness"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("settings.editor.zenMeshDistortion"),
    ).not.toBeInTheDocument();

    setCache({ "editor.zenBackground.shader": "warp" });
    rerender(<ZenBackgroundSettings />);
    expect(
      screen.getByLabelText("settings.editor.zenWarpShape"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("settings.editor.zenWarpIterations"),
    ).toBeInTheDocument();
  });

  it("keeps Dither and Color Halftone controls independently adjustable", () => {
    setCache({
      "editor.zenBackground.dither.enabled": "true",
      "editor.zenBackground.halftone.enabled": "false",
    });
    render(<ZenBackgroundSettings />);

    expect(
      screen.getByLabelText("settings.editor.zenDitherStrength"),
    ).toBeEnabled();
    expect(
      screen.getByLabelText("settings.editor.zenDitherLevels"),
    ).toBeEnabled();
    expect(
      screen.getByLabelText("settings.editor.zenHalftoneStrength"),
    ).toBeDisabled();
    expect(
      screen.getByLabelText("settings.editor.zenHalftoneAngle"),
    ).toBeDisabled();
  });
});
