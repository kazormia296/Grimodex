import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, KEY_SCOPE } from "./types";

describe("KEY_SCOPE — カバレッジ", () => {
  it("DEFAULT_SETTINGS の全 key が KEY_SCOPE に含まれる", () => {
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (key) => KEY_SCOPE[key] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("KEY_SCOPE の値は global か project のみ", () => {
    const invalid = Object.entries(KEY_SCOPE).filter(
      ([, scope]) => scope !== "global" && scope !== "project",
    );
    expect(invalid).toEqual([]);
  });

  // trashBin.* は Project タブの設定で「既定として保存」で新規プロジェクトへ継承させる。
  // project スコープでないと legacy(appSettings)へ書かれ getAllProjectSettings の集計
  // から漏れて defaults に乗らない（回帰防止）。
  it("trashBin.* は project スコープ", () => {
    expect(KEY_SCOPE["trashBin.enabled"]).toBe("project");
    expect(KEY_SCOPE["trashBin.retentionDays"]).toBe("project");
  });
});

describe("DEFAULT_SETTINGS — Beat Phase C keys", () => {
  it("beat.injectIntoContext のデフォルトは true", () => {
    expect(DEFAULT_SETTINGS["beat.injectIntoContext"]).toBe("true");
  });

  it("beat.inferRoles のデフォルトは true", () => {
    expect(DEFAULT_SETTINGS["beat.inferRoles"]).toBe("true");
  });

  it("beat.roleInferenceConfidenceThreshold のデフォルトは 0.7", () => {
    expect(DEFAULT_SETTINGS["beat.roleInferenceConfidenceThreshold"]).toBe(
      "0.7",
    );
  });
});

describe("DEFAULT_SETTINGS / KEY_SCOPE — chat episodic recall toggle", () => {
  // 回帰: ai.chatRecall は chatStore が getBoolean で読みガード済みだったが
  // KEY_SCOPE / DEFAULT_SETTINGS に未登録で UI から OFF にできず実質強制 ON
  // だった。project スコープ + 既定 true で登録し切替可能にする。
  it("ai.chatRecall は project スコープ", () => {
    expect(KEY_SCOPE["ai.chatRecall"]).toBe("project");
  });

  it("ai.chatRecall のデフォルトは true（既定で過去対話を注入）", () => {
    expect(DEFAULT_SETTINGS["ai.chatRecall"]).toBe("true");
  });
});

describe("DEFAULT_SETTINGS / KEY_SCOPE — IME integration Phase 2", () => {
  it("IME settings are global user preferences", () => {
    expect(KEY_SCOPE["ime.integrationMode"]).toBe("global");
    expect(KEY_SCOPE["ime.excludeHidden"]).toBe("global");
    expect(KEY_SCOPE["ime.includeProfile"]).toBe("global");
  });

  it("defaults to consumer-aware auto mode with profile enabled", () => {
    expect(DEFAULT_SETTINGS["ime.integrationMode"]).toBe("auto");
    expect(DEFAULT_SETTINGS["ime.excludeHidden"]).toBe("false");
    expect(DEFAULT_SETTINGS["ime.includeProfile"]).toBe("true");
  });
});

describe("DEFAULT_SETTINGS / KEY_SCOPE — Codex 読み登録確認", () => {
  it("確認トーストは既定 ON のグローバル設定", () => {
    expect(KEY_SCOPE["editor.promptCodexReadingOnRuby"]).toBe("global");
    expect(DEFAULT_SETTINGS["editor.promptCodexReadingOnRuby"]).toBe("true");
  });
});

describe("DEFAULT_SETTINGS / KEY_SCOPE — Zen shader background", () => {
  const zenShaderKeys = [
    "editor.zenBackground.enabled",
    "editor.zenBackground.shader",
    "editor.zenBackground.paletteMode",
    "editor.zenBackground.opacity",
    "editor.zenBackground.speed",
    "editor.zenBackground.speedPercent",
    "editor.zenBackground.shaderProps",
    "editor.zenBackground.scale",
    "editor.zenBackground.rotation",
    "editor.zenBackground.offsetX",
    "editor.zenBackground.offsetY",
    "editor.zenBackground.color1",
    "editor.zenBackground.color2",
    "editor.zenBackground.color3",
    "editor.zenBackground.color4",
    "editor.zenBackground.colorBack",
    "editor.zenBackground.mesh.distortion",
    "editor.zenBackground.mesh.swirl",
    "editor.zenBackground.mesh.grainMixer",
    "editor.zenBackground.mesh.grainOverlay",
    "editor.zenBackground.grain.softness",
    "editor.zenBackground.grain.intensity",
    "editor.zenBackground.grain.noise",
    "editor.zenBackground.grain.shape",
    "editor.zenBackground.neuro.brightness",
    "editor.zenBackground.neuro.contrast",
    "editor.zenBackground.warp.proportion",
    "editor.zenBackground.warp.softness",
    "editor.zenBackground.warp.distortion",
    "editor.zenBackground.warp.swirl",
    "editor.zenBackground.warp.swirlIterations",
    "editor.zenBackground.warp.shape",
    "editor.zenBackground.warp.shapeScale",
    "editor.zenBackground.staticMesh.positions",
    "editor.zenBackground.staticMesh.waveX",
    "editor.zenBackground.staticMesh.waveXShift",
    "editor.zenBackground.staticMesh.waveY",
    "editor.zenBackground.staticMesh.waveYShift",
    "editor.zenBackground.staticMesh.mixing",
    "editor.zenBackground.staticMesh.grainMixer",
    "editor.zenBackground.staticMesh.grainOverlay",
    "editor.zenBackground.dither.enabled",
    "editor.zenBackground.dither.strength",
    "editor.zenBackground.dither.size",
    "editor.zenBackground.dither.levels",
    "editor.zenBackground.halftone.enabled",
    "editor.zenBackground.halftone.strength",
    "editor.zenBackground.halftone.size",
    "editor.zenBackground.halftone.angle",
    "editor.zenBackground.halftone.softness",
    "editor.zenBackground.contrastGuard.mode",
    "editor.zenBackground.contrastGuard.strength",
    "editor.zenBackground.contrastGuard.toolMix",
    "editor.zenBackground.glass.enabled",
    "editor.zenBackground.glass.blur",
    "editor.zenBackground.glass.refraction",
    "editor.zenBackground.glass.saturation",
    "editor.zenBackground.glass.shine",
  ];

  it("persists every shader and post-filter control as a global preference", () => {
    expect(zenShaderKeys.every((key) => KEY_SCOPE[key] === "global")).toBe(
      true,
    );
    expect(
      zenShaderKeys.every((key) => DEFAULT_SETTINGS[key] !== undefined),
    ).toBe(true);
  });

  it("defaults to a subtle moving Mesh Gradient with both filters opt-in", () => {
    expect(DEFAULT_SETTINGS["editor.zenBackground.enabled"]).toBe("true");
    expect(DEFAULT_SETTINGS["editor.zenBackground.shader"]).toBe(
      "mesh-gradient",
    );
    expect(DEFAULT_SETTINGS["editor.zenBackground.paletteMode"]).toBe("theme");
    expect(DEFAULT_SETTINGS["editor.zenBackground.opacity"]).toBe("10");
    expect(DEFAULT_SETTINGS["editor.zenBackground.speedPercent"]).toBe("8");
    expect(KEY_SCOPE).not.toHaveProperty("editor.zenBackground.paperOpacity");
    expect(KEY_SCOPE).not.toHaveProperty("editor.zenBackground.paperEdgeFade");
    expect(DEFAULT_SETTINGS).not.toHaveProperty(
      "editor.zenBackground.paperOpacity",
    );
    expect(DEFAULT_SETTINGS).not.toHaveProperty(
      "editor.zenBackground.paperEdgeFade",
    );
    expect(DEFAULT_SETTINGS["editor.zenBackground.shaderProps"]).toBe("{}");
    expect(DEFAULT_SETTINGS["editor.zenBackground.dither.enabled"]).toBe(
      "false",
    );
    expect(DEFAULT_SETTINGS["editor.zenBackground.halftone.enabled"]).toBe(
      "false",
    );
    expect(DEFAULT_SETTINGS["editor.zenBackground.contrastGuard.mode"]).toBe(
      "auto",
    );
    expect(
      DEFAULT_SETTINGS["editor.zenBackground.contrastGuard.strength"],
    ).toBe("1");
    expect(DEFAULT_SETTINGS["editor.zenBackground.contrastGuard.toolMix"]).toBe(
      "0.5",
    );
    expect(DEFAULT_SETTINGS["editor.zenBackground.glass.enabled"]).toBe("true");
    expect(DEFAULT_SETTINGS["editor.zenBackground.glass.blur"]).toBe("14");
    expect(DEFAULT_SETTINGS["editor.zenBackground.glass.refraction"]).toBe("7");
    expect(DEFAULT_SETTINGS["editor.zenBackground.glass.saturation"]).toBe(
      "1.16",
    );
    expect(DEFAULT_SETTINGS["editor.zenBackground.glass.shine"]).toBe("1");
  });
});
