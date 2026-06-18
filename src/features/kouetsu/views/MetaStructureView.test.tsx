// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaStructureView } from "./MetaStructureView";

const nodes = [
  {
    id: "f1",
    projectId: "p1",
    parentId: null,
    nodeType: "folder",
    title: "章1",
    sortOrder: "a",
    charCount: 0,
    synopsis: null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
  },
  {
    id: "s1",
    projectId: "p1",
    parentId: "f1",
    nodeType: "scene",
    title: "A",
    sortOrder: "a",
    charCount: 0,
    synopsis: null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
  },
  {
    id: "s2",
    projectId: "p1",
    parentId: "f1",
    nodeType: "scene",
    title: "B",
    sortOrder: "b",
    charCount: 0,
    synopsis: null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
  },
];
const treeState = {
  projectId: "p1",
  scenes: [
    { id: "s1", title: "A" },
    { id: "s2", title: "B" },
  ],
  nodes,
  setActiveScene: vi.fn(),
};
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    (sel: (s: typeof treeState) => unknown) => sel(treeState),
    { getState: () => treeState },
  ),
}));

const lensState = {
  bySceneId: new Map([
    [
      "s1",
      [
        {
          id: "s1-ps",
          projectId: "p1",
          runId: "r",
          targetId: "s1",
          lensType: "plot_structure",
          metrics: { tension: 0.6 },
          finding: "x",
          severity: "info",
          createdAt: "2024",
          runCompletedAt: null,
        },
      ],
    ],
    [
      "s2",
      [
        {
          id: "s2-ps",
          projectId: "p1",
          runId: "r",
          targetId: "s2",
          lensType: "plot_structure",
          metrics: { tension: 0.2 },
          finding: "y",
          severity: "info",
          createdAt: "2024",
          runCompletedAt: null,
        },
      ],
    ],
  ]),
  load: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/features/post-effect/lensStore", () => ({
  useLensStore: (sel: (s: typeof lensState) => unknown) => sel(lensState),
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: Object.assign(() => undefined, {
    getState: () => ({ settings: { model: "m" }, loadSettings: vi.fn() }),
  }),
}));
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: null }),
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({ blockIfUnlicensed: () => false }));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: Object.assign(() => undefined, {
    getState: () => ({ get: () => "" }),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Additional mocks for modules imported by MetaStructureView that crash under happy-dom
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({
    postEffect: {
      metaStructureSystem: "system prompt",
    },
  }),
}));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  buildMultiPayload: vi.fn().mockResolvedValue({ scenes: [], inputHash: "h" }),
  getSceneIdsForScope: vi.fn().mockReturnValue([]),
}));
vi.mock("@/features/post-effect/metaStructurePayloadBuilder", () => ({
  buildMetaStructurePayload: vi
    .fn()
    .mockResolvedValue({ sceneText: "", inputHash: "h" }),
  META_STRUCTURE_PROMPT_VERSION: 1,
}));
vi.mock("@/features/post-effect/api", () => ({
  flushPendingSceneSaves: vi.fn().mockResolvedValue(undefined),
  runPostEffect: vi.fn(),
  runPostEffectMulti: vi.fn(),
}));
vi.mock("@/features/post-effect/customInstruction", () => ({
  appendKouetsuGuidance: (_s: string) => _s,
  appendStoryContextGuidance: (_s: string) => _s,
}));
vi.mock("@/features/post-effect/storyContext", () => ({
  selectStoryContext: vi.fn().mockReturnValue(null),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("MetaStructureView tension curve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("project スコープ＋tension あり → 波形を表示", () => {
    render(<MetaStructureView scope="project" />);
    expect(screen.getByLabelText("kouetsu.tension.title")).toBeInTheDocument();
  });

  it("current スコープでは波形を出さない", () => {
    render(<MetaStructureView scope="current" sceneId="s1" />);
    expect(screen.queryByLabelText("kouetsu.tension.title")).toBeNull();
  });
});
