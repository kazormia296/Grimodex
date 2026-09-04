import type { WorkLayerModel } from "./types";
import { WORK_LAYER_FIXTURE } from "./workLayerFixture";
import type { WorkLayerMode } from "./workLayerReducer";

export type WorkLayerPrototypeMode =
  | "ambient"
  | "arrive"
  | "tray-focus"
  | "tray-attention"
  | "ledger"
  | "lens"
  | "resolved"
  | "portal"
  | "inspect"
  | "projection"
  | "change-review"
  | "batch"
  | "system-activity"
  | "system-blocked"
  | "empty"
  | "disposed";

export const WORK_LAYER_PROTOTYPE_MODES: ReadonlyArray<{
  readonly id: WorkLayerPrototypeMode;
  readonly label: string;
}> = [
  { id: "ambient", label: "AMBIENT" },
  { id: "arrive", label: "ARRIVE +1" },
  { id: "tray-focus", label: "TRAY·FOCUS" },
  { id: "tray-attention", label: "TRAY·ATTN" },
  { id: "ledger", label: "ALL WORK" },
  { id: "lens", label: "LENS" },
  { id: "resolved", label: "RESOLVED" },
  { id: "portal", label: "PORTAL" },
  { id: "inspect", label: "INSPECT" },
  { id: "projection", label: "PROJECTION" },
  { id: "change-review", label: "REVIEW" },
  { id: "batch", label: "BATCH" },
  { id: "system-activity", label: "SYS·RUN" },
  { id: "system-blocked", label: "BLOCKED" },
  { id: "empty", label: "EMPTY" },
  { id: "disposed", label: "DISPOSED" },
];

export const EXPECTED_PROTOTYPE_NAVIGATION: Record<
  WorkLayerPrototypeMode,
  WorkLayerMode
> = {
  ambient: "ambient",
  arrive: "ambient",
  "tray-focus": "tray-focus",
  "tray-attention": "tray-attention",
  ledger: "ledger",
  lens: "lens",
  resolved: "resolved",
  portal: "portal",
  inspect: "inspect",
  projection: "projection",
  "change-review": "change-review",
  batch: "batch",
  "system-activity": "system-activity",
  "system-blocked": "system-blocked",
  empty: "tray-attention",
  disposed: "tray-disposed",
};

export function modelForPrototypeMode(
  mode: WorkLayerPrototypeMode,
): WorkLayerModel {
  if (mode === "arrive") {
    return {
      ...WORK_LAYER_FIXTURE,
      attentionDelta: 1,
      attentionAnchorVisible: true,
      attentionAnchorPosition: {
        xPercent: 48,
        yPercent: 36,
        heightPx: 96,
      },
      codexPanelAvailable: true,
      system: {
        ...WORK_LAYER_FIXTURE.system,
        state: "running",
        label: "recheck",
      },
    };
  }
  if (mode === "empty") {
    return {
      ...WORK_LAYER_FIXTURE,
      codexPanelAvailable: true,
      focus: null,
      attention: [],
      disposedAttention: [],
      allWork: [
        {
          id: "empty-blue-sword",
          title: "伏線『青い剣』の回収位置を再確認",
          status: "waiting",
          detail: "Codex: 青い剣",
          updatedLabel: "昨日",
        },
        {
          id: "empty-east-west",
          title: "東西分断後の時系列を確認",
          status: "waiting",
          detail: "Chronicle: 分断",
          updatedLabel: "3日前",
        },
        {
          id: "empty-dungeon-completed",
          title: "地下牢の改稿",
          status: "completed",
          updatedLabel: "昨日 完了",
        },
      ],
      batchProposals: [],
    };
  }
  if (mode === "portal") {
    return { ...WORK_LAYER_FIXTURE, codexPanelAvailable: false };
  }
  if (mode === "system-activity" || mode === "system-blocked") {
    const blocked = mode === "system-blocked";
    return {
      ...WORK_LAYER_FIXTURE,
      codexPanelAvailable: true,
      system: {
        ...WORK_LAYER_FIXTURE.system,
        state: blocked ? "blocked" : "running",
        label: blocked ? "contract" : "recheck",
      },
    };
  }
  return { ...WORK_LAYER_FIXTURE, codexPanelAvailable: true };
}

export function prototypeModeForNavigation(
  mode: WorkLayerMode,
): WorkLayerPrototypeMode {
  return mode === "tray-disposed" ? "disposed" : mode;
}
