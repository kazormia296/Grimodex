import type { DockviewApi, SerializedDockview } from "dockview-react";
import i18next from "i18next";
import { getPanelTitle } from "./layoutStore";

/* ── Types ── */

export interface BuiltinPreset {
  id: string;
  name: string;
  builtin: true;
  build: (api: DockviewApi) => void;
}

export interface CustomPreset {
  id: string;
  name: string;
  builtin: false;
  layout: SerializedDockview;
}

export type LayoutPreset = BuiltinPreset | CustomPreset;

/* ── Builtin layout builders ── */

function buildDefault(api: DockviewApi) {
  api.addPanel({
    id: "scenes",
    component: "scenes",
    title: getPanelTitle("scenes"),
  });
  api.addPanel({
    id: "editor",
    component: "editor",
    title: getPanelTitle("editor"),
    position: { referencePanel: "scenes", direction: "right" },
    minimumWidth: 320,
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: getPanelTitle("chat"),
    position: { referencePanel: "editor", direction: "right" },
  });
  api.addPanel({
    id: "chat-history",
    component: "chat-history",
    title: getPanelTitle("chat-history"),
    position: { referencePanel: "chat", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "codex-quick",
    component: "codex-quick",
    title: getPanelTitle("codex-quick"),
    position: { referencePanel: "scenes", direction: "below" },
  });
  api.addPanel({
    id: "codex",
    component: "codex",
    title: getPanelTitle("codex"),
    position: { referencePanel: "chat", direction: "below" },
  });
  api.addPanel({
    id: "snippets",
    component: "snippets",
    title: getPanelTitle("snippets"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });

  api.addPanel({
    id: "matrix",
    component: "matrix",
    title: getPanelTitle("matrix"),
    position: { referencePanel: "snippets", direction: "within" },
    inactive: true,
  });

  const leftGroup = api.getPanel("scenes")?.group;
  const rightGroup = api.getPanel("chat")?.group;
  if (leftGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.18) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.3) });
  }
  api.getPanel("scenes")?.api.setActive();
}

function buildChatMain(api: DockviewApi) {
  // 1. Create 3 columns first: scenes | chat | codex
  api.addPanel({
    id: "scenes",
    component: "scenes",
    title: getPanelTitle("scenes"),
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: getPanelTitle("chat"),
    position: { referencePanel: "scenes", direction: "right" },
  });
  api.addPanel({
    id: "codex",
    component: "codex",
    title: getPanelTitle("codex"),
    position: { referencePanel: "chat", direction: "right" },
  });

  // 2. Add tabs within groups
  api.addPanel({
    id: "chat-history",
    component: "chat-history",
    title: getPanelTitle("chat-history"),
    position: { referencePanel: "chat", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "snippets",
    component: "snippets",
    title: getPanelTitle("snippets"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });

  // 3. Split left column vertically LAST (after columns are established)
  api.addPanel({
    id: "editor",
    component: "editor",
    title: getPanelTitle("editor"),
    position: { referencePanel: "scenes", direction: "below" },
    minimumWidth: 320,
  });

  api.addPanel({
    id: "matrix",
    component: "matrix",
    title: getPanelTitle("matrix"),
    position: { referencePanel: "snippets", direction: "within" },
    inactive: true,
  });

  // 4. Set sizes: left ~15%, right ~30%, center gets the rest (~55%)
  const leftGroup = api.getPanel("scenes")?.group;
  const rightGroup = api.getPanel("codex")?.group;
  if (leftGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.15) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.3) });
  }
  api.getPanel("chat")?.api.setActive();
}

function buildCodexMain(api: DockviewApi) {
  // Codex(Snippets) | Editor | Chat(Chat History)
  api.addPanel({
    id: "codex",
    component: "codex",
    title: getPanelTitle("codex"),
  });
  api.addPanel({
    id: "editor",
    component: "editor",
    title: getPanelTitle("editor"),
    position: { referencePanel: "codex", direction: "right" },
    minimumWidth: 320,
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: getPanelTitle("chat"),
    position: { referencePanel: "editor", direction: "right" },
  });
  api.addPanel({
    id: "snippets",
    component: "snippets",
    title: getPanelTitle("snippets"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "chat-history",
    component: "chat-history",
    title: getPanelTitle("chat-history"),
    position: { referencePanel: "chat", direction: "within" },
    inactive: true,
  });

  api.addPanel({
    id: "matrix",
    component: "matrix",
    title: getPanelTitle("matrix"),
    position: { referencePanel: "snippets", direction: "within" },
    inactive: true,
  });

  const leftGroup = api.getPanel("codex")?.group;
  const rightGroup = api.getPanel("chat")?.group;
  if (leftGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.3) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.25) });
  }
  api.getPanel("codex")?.api.setActive();
}

/* ── Exports ── */

export function getBuiltinPresets(): BuiltinPreset[] {
  return [
    {
      id: "builtin:default",
      name: i18next.t("layout.preset.default"),
      builtin: true,
      build: buildDefault,
    },
    {
      id: "builtin:chat-main",
      name: i18next.t("layout.preset.chatMain"),
      builtin: true,
      build: buildChatMain,
    },
    {
      id: "builtin:codex-main",
      name: i18next.t("layout.preset.codexMain"),
      builtin: true,
      build: buildCodexMain,
    },
  ];
}

export function getBuiltinPreset(id: string): BuiltinPreset | undefined {
  return getBuiltinPresets().find((p) => p.id === id);
}

/** Clear all panels from the layout */
export function clearLayout(api: DockviewApi) {
  for (const panel of [...api.panels]) {
    api.removePanel(panel);
  }
}
