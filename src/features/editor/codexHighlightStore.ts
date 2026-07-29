import { create } from "zustand";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";
import {
  readRuntimeSettingBoolean,
  writeRuntimeSetting,
} from "@/features/settings/runtimeSettings";
import type { LayerSetOptions } from "@/features/post-effect/types";

interface CodexHighlightState {
  matchTargets: CodexMatchTarget[];
  matchedEntryIds: string[];
  hoveredEntryId: string | null;
  enabled: boolean;
  typeColorMap: Record<string, ResolvedCodexColor>;

  setMatchTargets: (targets: CodexMatchTarget[]) => void;
  setMatchedEntryIds: (ids: string[]) => void;
  setHoveredEntryId: (id: string | null) => void;
  setEnabled: (enabled: boolean, opts?: LayerSetOptions) => void;
  setTypeColorMap: (map: Record<string, ResolvedCodexColor>) => void;
  /** 起動時に display.codexHighlight 設定から enabled を初期化する。 */
  initFromSettings: () => void;
}

export const useCodexHighlightStore = create<CodexHighlightState>()((set) => ({
  matchTargets: [],
  matchedEntryIds: [],
  hoveredEntryId: null,
  enabled: true,
  typeColorMap: {},
  setMatchTargets: (targets) => set({ matchTargets: targets }),
  setMatchedEntryIds: (ids) => set({ matchedEntryIds: ids }),
  setHoveredEntryId: (id) => set({ hoveredEntryId: id }),
  setEnabled: (enabled, opts) => {
    // 本文レイヤーのトグルからも呼ばれるため設定へ write-through する
    // （設定画面からの呼び出しでは同値の再書き込みになるだけで無害）。
    // persist:false はパネル連動 (Auto) の自動追従用 — 設定を汚さない。
    if (opts?.persist !== false) {
      writeRuntimeSetting("display.codexHighlight", String(enabled));
    }
    set({ enabled });
  },
  setTypeColorMap: (map) => set({ typeColorMap: map }),
  initFromSettings: () => {
    set({
      enabled: readRuntimeSettingBoolean("display.codexHighlight", true),
    });
  },
}));
