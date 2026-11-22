/**
 * アプリのコマンド registry。「id・実行関数 run・危険度」を 1 か所に持つ。
 *
 * キーの照合側（GlobalCommandHost、tabSwitchKeybinding）は、どのキーがどの
 * コマンドかを決めて `runAppCommand` を呼ぶだけにする。後続の PR で Chat の
 * agent が同じ `run` を呼べるようにするための土台で、PR1 は挙動を変えない。
 *
 * 文脈（phone か、export の開閉 callback 等）は `run(ctx)` に明示して渡す。
 * キーの host は自分の props から ctx を作って渡し（再 render や listener の
 * 登録順を変えない）、host は同じ ctx を commandContext の bridge にも登録する。
 * キー以外の呼び出し元は `runRegisteredAppCommand` で bridge の ctx を使う。
 * store にしないのは、ctx が非 serializable な callback で、購読も要らないため。
 *
 * `run` は「動作」だけを持つ。キー固有の条件（defaultPrevented、phone で
 * preventDefault しない等）は host に残す。`run` は同期で副作用を起こす
 * （キー処理のタイミングを変えないため）。
 */
import { useResultsPanelStore } from "@/features/commandCenter";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  findOverlayOfPanel,
  getOverlays,
} from "@/features/layout/layoutStateUtils";
import type { PanelId } from "@/features/layout/panelIds";
import { PANEL_COMMANDS } from "@/features/settings/keybindings";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { matchesMod } from "@/lib/platform";
import {
  getRegisteredCommandContext,
  type CommandContext,
} from "./commandContext";

/** view＝表示だけ、personal＝個人の設定、blocked＝agent に出さない。 */
export type CommandRisk = "view" | "personal" | "blocked";

export type CommandResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "unknown-command" | "no-host" };

export interface AppCommand {
  /** getCommands() の id と同じ（ユーザーのキー割当の保存と互換）。固定キーは独自の id。 */
  id: string;
  risk: CommandRisk;
  /**
   * agent（Chat の run_app_command）に出すか。`risk: "view"` で、利用者のデータを変えない、
   * 画面の表示だけの操作に限る。layout が変わるものは layout の退避（uiOperationUndo）で元に戻せる。
   * 例外は `openSettings`（Settings を開くだけで、利用者が閉じれば戻る。退避には含まれない）。
   * tab の model や開いている場面を変えるもの（分割・タブ切替）は出さない。
   * 実際に実行してよいかは `isAgentRunnable`（agent && view）で判定する。
   */
  agent: boolean;
  /** パネルの表示・トグルのコマンドが対象とするパネル。 */
  panel?: PanelId;
  /**
   * 固定キー（再割当不可）。getCommands()／DEFAULT_KEYBINDINGS／設定画面の
   * キー一覧には出さない。照合は `matches`（修飾キーの厳密一致ではない）。
   */
  fixedKey?: { binding: string; matches: (event: KeyboardEvent) => boolean };
  /** 今 `run` できるか。副作用なし。無ければ常に true。 */
  isAvailable?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, args?: unknown) => CommandResult;
}

const OK: CommandResult = { ok: true };

// ── overlay ──

function overlayCommand(
  id: "toggleLeftOverlay" | "toggleRightOverlay",
  side: "left" | "right",
): AppCommand {
  return {
    id,
    risk: "view",
    // layout store の transient な openOverlay だけを変える。退避で戻せる。
    agent: true,
    isAvailable: (ctx) =>
      !ctx.phoneWorkspace &&
      getOverlays(useLayoutStore.getState().layout)[side].panel !== null,
    run: () => {
      // zoom 中の解除は store の開く側が担う。layout は変えない。
      useLayoutStore.getState().toggleOverlay(side);
      return OK;
    },
  };
}

// ── 検索・export（固定キー）──

const exportCommand: AppCommand = {
  id: "toggleExport",
  risk: "blocked",
  agent: false,
  fixedKey: {
    binding: "Mod+Shift+E",
    matches: (event) =>
      matchesMod(event) && event.shiftKey && event.key.toLowerCase() === "e",
  },
  isAvailable: (ctx) => ctx.runtimeCapabilities.genericProjectTransfer,
  run: (ctx) => {
    ctx.onToggleExport();
    return OK;
  },
};

const searchCommand: AppCommand = {
  id: "searchWorkspace",
  risk: "view",
  // 検索パネルを出して入力欄にフォーカスするだけ（検索語は入れない）。layout の退避で戻せる。
  agent: true,
  fixedKey: {
    binding: "Mod+Shift+F",
    matches: (event) =>
      matchesMod(event) && event.shiftKey && event.key.toLowerCase() === "f",
  },
  run: (ctx) => {
    if (ctx.phoneWorkspace) {
      useCompactNavigationStore.getState().openSurface("search");
      requestAnimationFrame(() => {
        useResultsPanelStore.getState().requestFocus();
      });
      return OK;
    }
    useLayoutStore.getState().showPanel("command-center-results");
    useResultsPanelStore.getState().requestFocus();
    return OK;
  },
};

// ── パネル ──

function phoneSurfaceOf(panel: PanelId): string {
  return panel === "editor"
    ? "editor"
    : panel === "scenes"
      ? "scenes"
      : panel === "codex" || panel === "codex-quick"
        ? "codex"
        : panel === "chat" || panel === "chat-history"
          ? "ai"
          : "more";
}

function panelCommand(id: string, panel: PanelId): AppCommand {
  return {
    id,
    risk: "view",
    // パネルの表示の切替。layout の退避で戻せる。Chat と Chat History は agent が今まさに動いている
    // パネル（既定の配置では同じ slot で、片方を出すともう片方が隠れる）で、隠れると「元に戻す」の
    // 表示ごと見えなくなるので、agent には出さない（利用者のキー操作は従来どおり）。
    // それでも、利用者が同じ slot に置いた別のパネルやプリセットで Chat が隠れることはある（受け入れる。
    // 退避は会話の履歴のカードに残る。設計書 §7.4）。
    // TrashBin は mount 時と 1 時間ごとに、期限切れの項目を DB から永久削除する（pruneTrashItems）。
    // 開くだけで確認なしの削除が起きるので、agent には出さない（利用者のキー操作は従来どおり）。
    agent:
      panel !== "chat" && panel !== "chat-history" && panel !== "trash-bin",
    panel,
    run: (ctx) => {
      if (ctx.phoneWorkspace) {
        useCompactNavigationStore.getState().openSurface(phoneSurfaceOf(panel));
        return OK;
      }
      // overlay にあるパネルは、トグルすると閉じてすぐ開き直すので、開く側だけ呼ぶ。
      if (
        panel === "codex-quick" &&
        findOverlayOfPanel(useLayoutStore.getState().layout, "codex-quick") !==
          null
      ) {
        useLayoutStore.getState().showPanel("codex-quick");
        return OK;
      }
      useLayoutStore.getState().togglePanel(panel);
      if (panel === "codex-quick") {
        requestAnimationFrame(() => {
          useLayoutStore.getState().showPanel("codex-quick");
        });
      }
      return OK;
    },
  };
}

// ── 設定・分割・タブ切替 ──

const openSettingsCommand: AppCommand = {
  id: "openSettings",
  risk: "view",
  // Settings 画面を開くだけ（何も変更しない）。layout の退避には含まれず、閉じるのは利用者の通常の操作
  // （「元に戻す」は出さない。結果は undoable: false）。
  agent: true,
  run: (ctx) => {
    ctx.onOpenSettings();
    return OK;
  },
};

function splitCommand(
  id: "splitVertical" | "splitHorizontal",
  direction: "right" | "below",
): AppCommand {
  return {
    id,
    risk: "view",
    // tab の model（第 2 グループ）を変える。layout の退避では戻せず、開いている場面の表示も替わるので、
    // agent には出さない。
    agent: false,
    run: (ctx) => {
      // phone は単一文書の投影で、隠れた desktop の tab model を変えない。
      if (ctx.phoneWorkspace) return { ok: false, reason: "unavailable" };
      const tabs = useTabStore.getState();
      if (tabs.activeTabId) {
        tabs.openInSecondaryGroupDirectional(tabs.activeTabId, direction);
      } else {
        tabs.createEmptySecondaryGroup(direction);
      }
      return OK;
    },
  };
}

function tabSwitchCommand(
  id: "nextTab" | "prevTab",
  direction: "next" | "previous",
): AppCommand {
  return {
    id,
    risk: "view",
    // 開いている場面（active scene）を切り替える。layout の退避では戻せず、編集中の画面が替わるので、
    // agent には出さない（chat の scope への影響は未確認）。
    agent: false,
    isAvailable: (ctx) => !ctx.phoneWorkspace,
    run: (ctx) => {
      if (ctx.phoneWorkspace) return { ok: false, reason: "unavailable" };
      const {
        activeGroupIndex,
        tabs,
        activeTabId,
        secondaryTabs,
        secondaryActiveTabId,
        setActiveTab,
        setSecondaryActiveTab,
      } = useTabStore.getState();
      const currentTabs = activeGroupIndex === 0 ? tabs : secondaryTabs;
      const currentActiveId =
        activeGroupIndex === 0 ? activeTabId : secondaryActiveTabId;

      if (currentTabs.length < 2) return OK;
      const currentIndex = currentTabs.findIndex(
        (tab) => tab.nodeId === currentActiveId,
      );
      if (currentIndex === -1) return OK;

      const nextIndex =
        direction === "previous"
          ? (currentIndex - 1 + currentTabs.length) % currentTabs.length
          : (currentIndex + 1) % currentTabs.length;
      const nextTab = currentTabs[nextIndex]!;

      if (activeGroupIndex === 0) {
        setActiveTab(nextTab.nodeId);
      } else {
        setSecondaryActiveTab(nextTab.nodeId);
      }
      if (nextTab.contentType === "scene") {
        useTreeStore.getState().setActiveScene(nextTab.nodeId);
      }
      return OK;
    },
  };
}

// ── registry（module load で 1 回だけ作る。毎打鍵で i18n を引かない）──

const APP_COMMANDS: readonly AppCommand[] = [
  overlayCommand("toggleLeftOverlay", "left"),
  overlayCommand("toggleRightOverlay", "right"),
  exportCommand,
  searchCommand,
  ...PANEL_COMMANDS.map(({ id, panel }) => panelCommand(id, panel)),
  openSettingsCommand,
  splitCommand("splitVertical", "right"),
  splitCommand("splitHorizontal", "below"),
  tabSwitchCommand("nextTab", "next"),
  tabSwitchCommand("prevTab", "previous"),
];

const APP_COMMANDS_BY_ID: ReadonlyMap<string, AppCommand> = new Map(
  APP_COMMANDS.map((command) => [command.id, command]),
);

/** 全コマンド（キー照合の順ではなく、定義順）。 */
export function listAppCommands(): readonly AppCommand[] {
  return APP_COMMANDS;
}

export function getAppCommand(id: string): AppCommand | undefined {
  return APP_COMMANDS_BY_ID.get(id);
}

/** Chat の agent が実行してよいか（view で、agent に出すと決めたコマンドだけ）。 */
export function isAgentRunnable(command: AppCommand): boolean {
  return command.agent && command.risk === "view";
}

/** agent が実行してよいコマンドの id（定義順）。 */
export function listAgentRunnableCommandIds(): string[] {
  return APP_COMMANDS.filter(isAgentRunnable).map((command) => command.id);
}

/** 固定キー（再割当不可）のコマンドに、この keydown が当たるか。 */
export function matchesFixedKey(id: string, event: KeyboardEvent): boolean {
  return APP_COMMANDS_BY_ID.get(id)?.fixedKey?.matches(event) ?? false;
}

export function isAppCommandAvailable(
  id: string,
  ctx: CommandContext,
): boolean {
  const command = APP_COMMANDS_BY_ID.get(id);
  if (!command) return false;
  return command.isAvailable ? command.isAvailable(ctx) : true;
}

/**
 * コマンドを実行する。存在しない id と、今は `run` できない状態（phone での
 * overlay 開閉等）は、副作用なしで ok:false を返す。
 */
export function runAppCommand(
  id: string,
  ctx: CommandContext,
  args?: unknown,
): CommandResult {
  const command = APP_COMMANDS_BY_ID.get(id);
  if (!command) return { ok: false, reason: "unknown-command" };
  if (command.isAvailable && !command.isAvailable(ctx)) {
    return { ok: false, reason: "unavailable" };
  }
  return command.run(ctx, args);
}

/** キー以外の呼び出し元向け。登録済みの host の文脈で実行する。 */
export function runRegisteredAppCommand(
  id: string,
  args?: unknown,
): CommandResult {
  const ctx = getRegisteredCommandContext();
  if (!ctx) return { ok: false, reason: "no-host" };
  return runAppCommand(id, ctx, args);
}
