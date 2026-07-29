import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import {
  createWorkspaceHydrator,
  type WorkspaceHydrationDependencies,
} from "./workspaceHydration";

function createDependencies(calls: string[]): WorkspaceHydrationDependencies {
  return {
    migrateAppSettingsToScopedStores: vi.fn(async () => {
      calls.push("migrate-app-settings");
    }),
    migrateModelRoleKeys: vi.fn(async () => {
      calls.push("migrate-model-roles");
    }),
    removeRetiredDisplaySettings: vi.fn(async () => {
      calls.push("remove-retired-display-settings");
    }),
    seedProjectSettingsFromDefaults: vi.fn(async () => {
      calls.push("seed-project-defaults");
    }),
    loadSettings: vi.fn(async (projectId: string) => {
      calls.push(`load-settings:${projectId}`);
    }),
    initCursorSettings: vi.fn(() => {
      calls.push("init-cursor-settings");
    }),
    initCodexHighlight: vi.fn(() => {
      calls.push("init-codex-highlight");
    }),
    initAttribution: vi.fn(() => {
      calls.push("init-attribution");
    }),
    initAnnotation: vi.fn(() => {
      calls.push("init-annotation");
    }),
    loadLintConfig: vi.fn(() => {
      calls.push("load-lint-config");
    }),
    loadTimelineSettings: vi.fn(() => {
      calls.push("load-timeline-settings");
    }),
    loadChronicleSettings: vi.fn(() => {
      calls.push("load-chronicle-settings");
    }),
    loadMapSettings: vi.fn(() => {
      calls.push("load-map-settings");
    }),
    loadGridSettings: vi.fn(() => {
      calls.push("load-grid-settings");
    }),
    loadMatrixSettings: vi.fn(() => {
      calls.push("load-matrix-settings");
    }),
  };
}

const settings = {
  recentWorkspaces: [],
  lastActiveWorkspace: null,
  theme: "system",
  uiLanguage: "ja",
  uiScale: 1,
  showLauncherOnStartup: false,
  timeline: {},
  chronicle: {},
  map: {},
  grid: {},
  matrix: {},
} as GlobalSettings;

describe("workspace hydration composition", () => {
  it("preserves migration, settings, and panel hydration order", async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);

    await createWorkspaceHydrator(dependencies)({
      projectId: "project-a",
      settings,
      isExisting: false,
    });

    expect(calls).toEqual([
      "migrate-app-settings",
      "remove-retired-display-settings",
      "migrate-model-roles",
      "seed-project-defaults",
      "load-settings:project-a",
      "init-cursor-settings",
      "init-codex-highlight",
      "init-attribution",
      "init-annotation",
      "load-lint-config",
      "load-timeline-settings",
      "load-chronicle-settings",
      "load-map-settings",
      "load-grid-settings",
      "load-matrix-settings",
    ]);
  });

  it("does not seed defaults when hydrating an existing workspace", async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);

    await createWorkspaceHydrator(dependencies)({
      projectId: "project-a",
      settings,
      isExisting: true,
    });

    expect(dependencies.seedProjectSettingsFromDefaults).not.toHaveBeenCalled();
    expect(calls).not.toContain("seed-project-defaults");
  });
});
