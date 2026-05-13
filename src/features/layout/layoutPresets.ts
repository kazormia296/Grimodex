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

function buildWrite(api: DockviewApi) {
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

  const leftGroup = api.getPanel("scenes")?.group;
  const rightGroup = api.getPanel("chat")?.group;
  if (leftGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.18) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.33) });
  }
  api.getPanel("scenes")?.api.setActive();
}

function buildPlan(api: DockviewApi) {
  // 1. Establish 2 horizontal columns first: grid | chat
  api.addPanel({
    id: "grid",
    component: "grid",
    title: getPanelTitle("grid"),
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: getPanelTitle("chat"),
    position: { referencePanel: "grid", direction: "right" },
  });

  // 2. Split each column vertically
  api.addPanel({
    id: "timeline",
    component: "timeline",
    title: getPanelTitle("timeline"),
    position: { referencePanel: "grid", direction: "below" },
  });
  api.addPanel({
    id: "codex",
    component: "codex",
    title: getPanelTitle("codex"),
    position: { referencePanel: "chat", direction: "below" },
  });

  // 3. Add tabs within groups
  api.addPanel({
    id: "map",
    component: "map",
    title: getPanelTitle("map"),
    position: { referencePanel: "grid", direction: "within" },
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
    id: "snippets",
    component: "snippets",
    title: getPanelTitle("snippets"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "foreshadow",
    component: "foreshadow",
    title: getPanelTitle("foreshadow"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "matrix",
    component: "matrix",
    title: getPanelTitle("matrix"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });

  // 4. Sizes
  const leftGroup = api.getPanel("grid")?.group;
  if (leftGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.67) });
  }
  const timelineGroup = api.getPanel("timeline")?.group;
  if (timelineGroup) {
    timelineGroup.api.setSize({ height: Math.round(api.height * 0.17) });
  }

  api.getPanel("grid")?.api.setActive();
  api.getPanel("codex")?.api.setActive();
}

function buildChat(api: DockviewApi) {
  // 2 columns: chat (with chat-history) | codex (with snippets, matrix)
  api.addPanel({
    id: "chat",
    component: "chat",
    title: getPanelTitle("chat"),
  });
  api.addPanel({
    id: "codex",
    component: "codex",
    title: getPanelTitle("codex"),
    position: { referencePanel: "chat", direction: "right" },
  });
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
  api.addPanel({
    id: "matrix",
    component: "matrix",
    title: getPanelTitle("matrix"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });

  const leftGroup = api.getPanel("chat")?.group;
  if (leftGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.67) });
  }
  api.getPanel("chat")?.api.setActive();
}

function buildReview(api: DockviewApi) {
  // 1. Establish 4 horizontal columns: scenes | editor | kouetsu | codex
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
    id: "kouetsu",
    component: "kouetsu",
    title: getPanelTitle("kouetsu"),
    position: { referencePanel: "editor", direction: "right" },
  });
  api.addPanel({
    id: "codex",
    component: "codex",
    title: getPanelTitle("codex"),
    position: { referencePanel: "kouetsu", direction: "right" },
  });

  // 2. Split left column vertically: scenes / attribution
  api.addPanel({
    id: "attribution",
    component: "attribution",
    title: getPanelTitle("attribution"),
    position: { referencePanel: "scenes", direction: "below" },
  });

  // 3. Add tabs within groups
  api.addPanel({
    id: "grid",
    component: "grid",
    title: getPanelTitle("grid"),
    position: { referencePanel: "scenes", direction: "within" },
    inactive: true,
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
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "foreshadow",
    component: "foreshadow",
    title: getPanelTitle("foreshadow"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "timeline",
    component: "timeline",
    title: getPanelTitle("timeline"),
    position: { referencePanel: "codex", direction: "within" },
    inactive: true,
  });

  // 4. Sizes (left ~13%, codex ~25%, kouetsu ~30%, editor takes the rest ~32%)
  const leftGroup = api.getPanel("scenes")?.group;
  const codexGroup = api.getPanel("codex")?.group;
  const kouetsuGroup = api.getPanel("kouetsu")?.group;
  if (leftGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.13) });
  }
  if (codexGroup) {
    codexGroup.api.setSize({ width: Math.round(api.width * 0.25) });
  }
  if (kouetsuGroup) {
    kouetsuGroup.api.setSize({ width: Math.round(api.width * 0.3) });
  }

  api.getPanel("scenes")?.api.setActive();
  api.getPanel("editor")?.api.setActive();
}

function buildCondense(api: DockviewApi) {
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
  api.addPanel({
    id: "map",
    component: "map",
    title: getPanelTitle("map"),
    position: { referencePanel: "editor", direction: "within" },
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
      build: buildWrite,
    },
    {
      id: "builtin:plan",
      name: i18next.t("layout.preset.plan"),
      builtin: true,
      build: buildPlan,
    },
    {
      id: "builtin:chat-main",
      name: i18next.t("layout.preset.chatMain"),
      builtin: true,
      build: buildChat,
    },
    {
      id: "builtin:review",
      name: i18next.t("layout.preset.review"),
      builtin: true,
      build: buildReview,
    },
    {
      id: "builtin:codex-main",
      name: i18next.t("layout.preset.codexMain"),
      builtin: true,
      build: buildCondense,
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
