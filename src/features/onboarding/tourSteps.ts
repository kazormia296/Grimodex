import type { AiPolicyToggles } from "@/features/ai-policy/types";
import type { PanelId } from "@/features/layout/layoutStore";

export type TourStepKey =
  | "workspace"
  | "scenes"
  | "layout"
  | "editor"
  | "snippets"
  | "codex"
  | "chat"
  | "codexExtract"
  | "foreshadow"
  | "consistency"
  | "timeline"
  | "export"
  | "end";

export interface TourSlide {
  /** Slide id — used as i18n suffix and motion key. */
  id: string;
  /** data-tour-target values to spotlight for this slide. */
  targets?: string[];
}

export interface TourStepDef {
  key: TourStepKey;
  panelId: PanelId | null;
  requires: keyof AiPolicyToggles | null;
  slides: TourSlide[];
  /** Index of the slide that requires the action gate. Defaults to last slide. */
  gatedSlideIndex?: number;
  /** No gate required — all slides advance freely. */
  passive?: boolean;
}

export interface TourStepOptions {
  /** Whether the current runtime exposes the project export workflow. */
  includeExport?: boolean;
}

export const ALL_STEPS: TourStepDef[] = [
  {
    key: "workspace",
    panelId: null,
    requires: null,
    passive: true,
    slides: [
      {
        id: "workspace",
        targets: ["workspace-menu"],
      },
      {
        id: "project",
        targets: ["project-menu"],
      },
    ],
  },
  {
    key: "scenes",
    panelId: "scenes",
    requires: null,
    slides: [
      { id: "overview" },
      { id: "addItems" },
      { id: "hierarchy" },
      { id: "action" },
    ],
  },
  {
    key: "layout",
    panelId: null,
    requires: null,
    passive: true,
    slides: [
      {
        id: "overview",
        targets: ["layout-preset-btn", "panel-toggle-btn"],
      },
    ],
  },
  {
    key: "editor",
    panelId: "editor",
    requires: null,
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "snippets",
    panelId: "snippets",
    requires: null,
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "codex",
    panelId: "codex",
    requires: null,
    gatedSlideIndex: 1,
    slides: [{ id: "overview" }, { id: "action" }, { id: "fourLayers" }],
  },
  {
    key: "chat",
    panelId: "chat",
    requires: "chat",
    passive: true,
    slides: [
      { id: "overview" },
      { id: "contextBar", targets: ["chat-context-bar"] },
      {
        id: "contextUsage",
        targets: ["chat-tokens-badge", "chat-context-progress"],
      },
    ],
  },
  {
    key: "codexExtract",
    panelId: "chat",
    requires: "chat",
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "foreshadow",
    panelId: "foreshadow",
    requires: null,
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "consistency",
    panelId: "kouetsu",
    requires: "analysis",
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "timeline",
    panelId: "timeline",
    requires: null,
    slides: [{ id: "overview" }, { id: "zoom" }],
  },
  {
    key: "export",
    panelId: null,
    requires: null,
    passive: true,
    slides: [{ id: "overview", targets: ["export-button"] }],
  },
  {
    key: "end",
    panelId: null,
    requires: null,
    slides: [{ id: "summary" }, { id: "restartHint" }],
  },
];

export function getTourSteps(
  toggles: AiPolicyToggles,
  options: TourStepOptions = {},
): TourStepDef[] {
  const includeExport = options.includeExport ?? true;

  return ALL_STEPS.filter((step) => {
    if (step.key === "export" && !includeExport) return false;
    return !step.requires || toggles[step.requires];
  });
}
