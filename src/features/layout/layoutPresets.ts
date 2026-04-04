import type { DockviewApi, SerializedDockview } from "dockview-react";
import { PANEL_TITLES } from "./layoutStore";

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
    title: PANEL_TITLES.scenes,
  });
  api.addPanel({
    id: "editor",
    component: "editor",
    title: PANEL_TITLES.editor,
    position: { referencePanel: "scenes", direction: "right" },
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: PANEL_TITLES.chat,
    position: { referencePanel: "editor", direction: "right" },
  });
  api.addPanel({
    id: "chat-history",
    component: "chat-history",
    title: PANEL_TITLES["chat-history"],
    position: { referencePanel: "chat", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "codex-quick",
    component: "codex-quick",
    title: PANEL_TITLES["codex-quick"],
    position: { referencePanel: "scenes", direction: "below" },
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
  api.addPanel({
    id: "scenes",
    component: "scenes",
    title: PANEL_TITLES.scenes,
  });
  api.addPanel({
    id: "editor",
    component: "editor",
    title: PANEL_TITLES.editor,
    position: { referencePanel: "scenes", direction: "right" },
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: PANEL_TITLES.chat,
    position: { referencePanel: "editor", direction: "right" },
  });
  api.addPanel({
    id: "chat-history",
    component: "chat-history",
    title: PANEL_TITLES["chat-history"],
    position: { referencePanel: "chat", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "snippets",
    component: "snippets",
    title: PANEL_TITLES.snippets,
    position: { referencePanel: "chat", direction: "below" },
  });

  const leftGroup = api.getPanel("scenes")?.group;
  const rightGroup = api.getPanel("chat")?.group;
  if (leftGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.14) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.5) });
  }
  api.getPanel("chat")?.api.setActive();
}

function buildCodexMain(api: DockviewApi) {
  api.addPanel({
    id: "scenes",
    component: "scenes",
    title: PANEL_TITLES.scenes,
  });
  api.addPanel({
    id: "codex",
    component: "codex",
    title: PANEL_TITLES.codex,
    position: { referencePanel: "scenes", direction: "within" },
  });
  api.addPanel({
    id: "codex-quick",
    component: "codex-quick",
    title: PANEL_TITLES["codex-quick"],
    position: { referencePanel: "scenes", direction: "below" },
  });
  api.addPanel({
    id: "editor",
    component: "editor",
    title: PANEL_TITLES.editor,
    position: { referencePanel: "scenes", direction: "right" },
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: PANEL_TITLES.chat,
    position: { referencePanel: "editor", direction: "right" },
  });

  const leftGroup = api.getPanel("scenes")?.group;
  const rightGroup = api.getPanel("chat")?.group;
  if (leftGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.28) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.2) });
  }
  api.getPanel("codex")?.api.setActive();
}

/* ── Exports ── */

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "builtin:default",
    name: "デフォルト",
    builtin: true,
    build: buildDefault,
  },
  {
    id: "builtin:chat-main",
    name: "チャットメイン",
    builtin: true,
    build: buildChatMain,
  },
  {
    id: "builtin:codex-main",
    name: "Codexメイン",
    builtin: true,
    build: buildCodexMain,
  },
];

export function getBuiltinPreset(id: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

/** Clear all panels from the layout */
export function clearLayout(api: DockviewApi) {
  for (const panel of [...api.panels]) {
    api.removePanel(panel);
  }
}
