import i18next from "i18next";
import {
  BookCheck,
  Library,
  MessageCircle,
  Network,
  PenLine,
  type LucideIcon,
} from "lucide-react";
import {
  clampLayoutStateForViewport,
  cloneLayoutState,
  ensureRegisteredPanels,
} from "./layoutStateUtils";
import type {
  BuiltinPresetOverride,
  LayoutState,
  ToolWindowPanelId,
} from "./layoutTypes";

export interface BuiltinPresetMeta {
  id: string;
  name: string;
  builtin: true;
  state: LayoutState;
  icon: LucideIcon;
}

export interface CustomPresetMeta {
  id: string;
  name: string;
  builtin: false;
}

export type LayoutPresetMeta = BuiltinPresetMeta | CustomPresetMeta;

export const BUILTIN_PRESET_IDS = [
  "builtin:default",
  "builtin:plan",
  "builtin:chat-main",
  "builtin:review",
  "builtin:codex-main",
] as const;

export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

export function isBuiltinPresetId(id: string): id is BuiltinPresetId {
  return (BUILTIN_PRESET_IDS as readonly string[]).includes(id);
}

const PRESET_I18N_KEYS: Record<BuiltinPresetId, string> = {
  "builtin:default": "layout.preset.default",
  "builtin:plan": "layout.preset.plan",
  "builtin:chat-main": "layout.preset.chatMain",
  "builtin:review": "layout.preset.review",
  "builtin:codex-main": "layout.preset.codexMain",
};

interface BuiltinPresetDefinition {
  /** ドロップダウンに表示する Lucide アイコン。 */
  icon: LucideIcon;
  /** プリセット本体。適用時に viewport へ clamp される。 */
  state: LayoutState;
  /** Stripe から外す tool window（slot 登録は state 側に維持）。 */
  hiddenStripePanels: ToolWindowPanelId[];
}

const PRESET_DEFINITIONS: Record<BuiltinPresetId, BuiltinPresetDefinition> = {
  "builtin:default": {
    icon: PenLine,
    state: {
      regions: {
        left: {
          size: 475,
          slots: [
            {
              id: "l0",
              sizeRatio: 0.4894159653149702,
              panels: ["scenes", "command-center-results"],
              activePanel: "scenes",
            },
            {
              id: "ldc62505d",
              sizeRatio: 0.11757204794695256,
              panels: ["timeline"],
              activePanel: null,
            },
            {
              id: "l1",
              sizeRatio: 0.3930119867380773,
              panels: ["codex-quick", "foreshadow", "kouetsu"],
              activePanel: "codex-quick",
            },
          ],
        },
        right: {
          size: 645,
          slots: [
            {
              id: "r0",
              sizeRatio: 0.42178217821782166,
              panels: ["chat"],
              activePanel: "chat",
            },
            {
              id: "rbde9d62e",
              sizeRatio: 0.6666666666666666,
              panels: ["chat-history"],
              activePanel: null,
            },
            {
              id: "r57854c5d",
              sizeRatio: 0.5782178217821783,
              panels: ["codex", "snippets"],
              activePanel: "codex",
            },
            {
              id: "r1",
              sizeRatio: 1,
              panels: ["attribution"],
              activePanel: null,
            },
          ],
        },
        bottom: {
          size: 330,
          slots: [
            {
              id: "b0",
              sizeRatio: 1,
              panels: ["map", "grid", "matrix"],
              activePanel: null,
            },
            {
              id: "b1",
              sizeRatio: 1,
              panels: ["trash-bin", "writing-stats", "related-scenes"],
              activePanel: null,
            },
          ],
        },
      },
      center: {
        editorOpen: true,
        segments: [{ id: "ceditor", kind: "editor", sizeRatio: 1 }],
      },
    },
    hiddenStripePanels: [
      "map",
      "grid",
      "matrix",
      "chronicle",
      "trash-bin",
      "writing-stats",
      "related-scenes",
    ],
  },
  "builtin:plan": {
    icon: Network,
    state: {
      regions: {
        left: {
          size: 363,
          slots: [
            {
              id: "l0",
              sizeRatio: 1,
              panels: ["scenes", "command-center-results"],
              activePanel: null,
            },
            {
              id: "l1",
              sizeRatio: 1,
              panels: ["codex-quick"],
              activePanel: null,
            },
          ],
        },
        right: {
          size: 896,
          slots: [
            {
              id: "r0",
              sizeRatio: 0.5121106159946215,
              panels: ["chat"],
              activePanel: "chat",
            },
            {
              id: "r15845c75",
              sizeRatio: 0.37858508604206503,
              panels: ["chat-history"],
              activePanel: null,
            },
            {
              id: "r405a4231",
              sizeRatio: 0.4878893840053786,
              panels: ["codex", "snippets", "matrix", "foreshadow"],
              activePanel: "codex",
            },
            {
              id: "r1",
              sizeRatio: 1,
              panels: ["attribution"],
              activePanel: null,
            },
          ],
        },
        bottom: {
          size: 165,
          slots: [
            {
              id: "b1",
              sizeRatio: 1,
              panels: [
                "kouetsu",
                "trash-bin",
                "timeline",
                "chronicle",
                "writing-stats",
                "related-scenes",
              ],
              activePanel: null,
            },
          ],
        },
      },
      center: {
        editorOpen: false,
        segments: [
          { id: "ceditor", kind: "editor", sizeRatio: 1 },
          {
            id: "ctcbae9d6f",
            kind: "tool",
            sizeRatio: 1,
            panels: ["grid", "map"],
            activePanel: "grid",
          },
        ],
      },
    },
    hiddenStripePanels: [
      "trash-bin",
      "kouetsu",
      "attribution",
      "writing-stats",
      "related-scenes",
    ],
  },
  "builtin:chat-main": {
    icon: MessageCircle,
    state: {
      regions: {
        left: {
          size: 397,
          slots: [
            {
              id: "l0",
              sizeRatio: 0.4894159653149702,
              panels: ["scenes", "command-center-results"],
              activePanel: null,
            },
            {
              id: "ldc62505d",
              sizeRatio: 0.11757204794695256,
              panels: ["timeline"],
              activePanel: null,
            },
            {
              id: "l1",
              sizeRatio: 0.3930119867380773,
              panels: ["codex-quick", "foreshadow", "kouetsu"],
              activePanel: null,
            },
          ],
        },
        right: {
          size: 798,
          slots: [
            {
              id: "rbde9d62e",
              sizeRatio: 1,
              panels: ["chat-history", "codex", "snippets"],
              activePanel: "chat-history",
            },
            {
              id: "r1",
              sizeRatio: 1,
              panels: ["attribution"],
              activePanel: null,
            },
          ],
        },
        bottom: {
          size: 330,
          slots: [
            {
              id: "b0",
              sizeRatio: 1,
              panels: ["map", "grid", "matrix"],
              activePanel: null,
            },
            {
              id: "b1",
              sizeRatio: 1,
              panels: ["trash-bin", "writing-stats", "related-scenes"],
              activePanel: null,
            },
          ],
        },
      },
      center: {
        editorOpen: false,
        segments: [
          { id: "ceditor", kind: "editor", sizeRatio: 1 },
          {
            id: "ct89df2b04",
            kind: "tool",
            sizeRatio: 1,
            panels: ["chat"],
            activePanel: "chat",
          },
        ],
      },
    },
    hiddenStripePanels: [
      "map",
      "grid",
      "matrix",
      "chronicle",
      "trash-bin",
      "attribution",
      "writing-stats",
      "related-scenes",
    ],
  },
  "builtin:review": {
    icon: BookCheck,
    state: {
      regions: {
        left: {
          size: 475,
          slots: [
            {
              id: "l0",
              sizeRatio: 0.4894159653149702,
              panels: ["scenes", "command-center-results"],
              activePanel: "scenes",
            },
            {
              id: "ldc62505d",
              sizeRatio: 0.11757204794695256,
              panels: ["timeline"],
              activePanel: null,
            },
            {
              id: "l1",
              sizeRatio: 0.3930119867380773,
              panels: ["codex-quick", "foreshadow", "attribution"],
              activePanel: "codex-quick",
            },
          ],
        },
        right: {
          size: 645,
          slots: [
            {
              id: "r0",
              sizeRatio: 0.42178217821782166,
              panels: ["chat"],
              activePanel: null,
            },
            {
              id: "rbde9d62e",
              sizeRatio: 0.6666666666666666,
              panels: ["chat-history"],
              activePanel: null,
            },
            {
              id: "r57854c5d",
              sizeRatio: 0.5782178217821783,
              panels: ["codex", "snippets"],
              activePanel: null,
            },
          ],
        },
        bottom: {
          size: 330,
          slots: [
            {
              id: "b0",
              sizeRatio: 1,
              panels: ["map", "grid", "matrix"],
              activePanel: null,
            },
            {
              id: "b1",
              sizeRatio: 1,
              panels: ["trash-bin", "writing-stats", "related-scenes"],
              activePanel: null,
            },
          ],
        },
      },
      center: {
        editorOpen: true,
        segments: [
          { id: "ceditor", kind: "editor", sizeRatio: 0.5 },
          {
            id: "cteca5de5f",
            kind: "tool",
            sizeRatio: 0.5,
            panels: ["kouetsu"],
            activePanel: "kouetsu",
          },
        ],
      },
    },
    hiddenStripePanels: [
      "map",
      "grid",
      "matrix",
      "chronicle",
      "trash-bin",
      "writing-stats",
      "related-scenes",
    ],
  },
  "builtin:codex-main": {
    icon: Library,
    state: {
      regions: {
        left: {
          size: 475,
          slots: [
            {
              id: "l0",
              sizeRatio: 0.4894159653149702,
              panels: ["scenes", "command-center-results"],
              activePanel: null,
            },
            {
              id: "ldc62505d",
              sizeRatio: 0.11757204794695256,
              panels: ["timeline"],
              activePanel: null,
            },
            {
              id: "l1",
              sizeRatio: 0.3930119867380773,
              panels: ["codex-quick", "foreshadow", "kouetsu"],
              activePanel: null,
            },
          ],
        },
        right: {
          size: 728,
          slots: [
            {
              id: "r0",
              sizeRatio: 0.5131739931468541,
              panels: ["chat"],
              activePanel: "chat",
            },
            {
              id: "rbde9d62e",
              sizeRatio: 0.486826006853146,
              panels: ["chat-history"],
              activePanel: null,
            },
            {
              id: "r1",
              sizeRatio: 1,
              panels: ["attribution"],
              activePanel: null,
            },
          ],
        },
        bottom: {
          size: 330,
          slots: [
            {
              id: "b0",
              sizeRatio: 1,
              panels: ["map", "grid", "matrix"],
              activePanel: null,
            },
            {
              id: "b1",
              sizeRatio: 1,
              panels: ["trash-bin", "writing-stats", "related-scenes"],
              activePanel: null,
            },
          ],
        },
      },
      center: {
        editorOpen: false,
        segments: [
          { id: "ceditor", kind: "editor", sizeRatio: 1 },
          {
            id: "ct9b619a84",
            kind: "tool",
            sizeRatio: 1,
            panels: ["codex", "snippets"],
            activePanel: "codex",
          },
        ],
      },
    },
    hiddenStripePanels: [
      "map",
      "grid",
      "matrix",
      "chronicle",
      "trash-bin",
      "writing-stats",
      "related-scenes",
    ],
  },
};

export function getBuiltinPresetState(
  id: string,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
): LayoutState | undefined {
  const definition = PRESET_DEFINITIONS[id as BuiltinPresetId];
  if (!definition) return undefined;
  // 新規登録パネル（例 chronicle）を curated プリセットへ自動補充する。これが無いと
  // PRESET_DEFINITIONS 未記載のパネルが欠け、適用時に validateLayoutState が invalid
  // 判定→fallback する。clampLayoutStateForViewport は内部で fresh clone を返すので、
  // その出力を ensureRegisteredPanels で in-place 補充する（余分な clone を足さない＝
  // applyPreset の structuredClone 回数の perf 契約を保つ）。
  return ensureRegisteredPanels(
    clampLayoutStateForViewport(definition.state, viewport),
  );
}

export function getBuiltinPresetHiddenPanels(id: string): ToolWindowPanelId[] {
  const definition = PRESET_DEFINITIONS[id as BuiltinPresetId];
  return definition ? [...definition.hiddenStripePanels] : [];
}

/**
 * 契約: 常に fresh なオブジェクトを返す (override path は明示 clone、
 * 非 override は clampLayoutStateForViewport が内部 clone した作業コピー)。
 * 呼び出し側での追加 clone は不要。
 */
export function resolveBuiltinPresetState(
  id: string,
  viewport: { width: number; height: number },
  override?: BuiltinPresetOverride,
): LayoutState | undefined {
  if (override) {
    // ユーザー保存の override も、保存後に追加された新パネルを補充する。
    return ensureRegisteredPanels(cloneLayoutState(override.state));
  }
  return getBuiltinPresetState(id, viewport);
}

export function resolveBuiltinPresetHiddenPanels(
  id: string,
  override?: BuiltinPresetOverride,
): ToolWindowPanelId[] {
  if (override) {
    return [...(override.hiddenStripePanels ?? [])];
  }
  return getBuiltinPresetHiddenPanels(id);
}

export function getBuiltinPresets(
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
  overrides: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>> = {},
): BuiltinPresetMeta[] {
  return BUILTIN_PRESET_IDS.map((id) => {
    const state = resolveBuiltinPresetState(id, viewport, overrides[id]);
    if (!state) {
      throw new Error(`Unknown builtin preset: ${id}`);
    }
    return {
      id,
      name: i18next.t(PRESET_I18N_KEYS[id]),
      builtin: true as const,
      // resolveBuiltinPresetState が fresh を保証するため再 clone しない
      state,
      icon: PRESET_DEFINITIONS[id].icon,
    };
  });
}

export function getBuiltinPreset(id: string): BuiltinPresetMeta | undefined {
  return getBuiltinPresets().find((p) => p.id === id);
}
