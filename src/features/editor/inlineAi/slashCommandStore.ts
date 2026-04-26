import { create } from "zustand";
import type { InlineAiCommand } from "./inlineAiTypes";

export interface SlashCommandRect {
  top: number;
  left: number;
  bottom: number;
}

interface SlashOpenParams {
  items: InlineAiCommand[];
  query: string;
  rect: SlashCommandRect | null;
  commandFn: (item: InlineAiCommand) => void;
}

interface SlashUpdateParams {
  items: InlineAiCommand[];
  query: string;
  rect: SlashCommandRect | null;
}

interface SlashCommandState {
  isOpen: boolean;
  items: InlineAiCommand[];
  query: string;
  rect: SlashCommandRect | null;
  /**
   * Suggestion プラグインが発行する確定コールバック。
   * Popup の onSelect はこれを呼び、結果として Extension の
   * `command({ editor, range, props })` が起動する。
   */
  commandFn: ((item: InlineAiCommand) => void) | null;
  /**
   * Popup 側で設定するキーボードハンドラ。
   * Extension の Suggestion は onKeyDown でこれを呼び、true を返せば
   * エディタへの伝播を止める。
   */
  keyHandler: ((event: KeyboardEvent) => boolean) | null;

  open: (params: SlashOpenParams) => void;
  update: (params: SlashUpdateParams) => void;
  setKeyHandler: (handler: ((e: KeyboardEvent) => boolean) | null) => void;
  close: () => void;
}

export const useSlashCommandStore = create<SlashCommandState>()((set) => ({
  isOpen: false,
  items: [],
  query: "",
  rect: null,
  commandFn: null,
  keyHandler: null,

  open({ items, query, rect, commandFn }) {
    set({ isOpen: true, items, query, rect, commandFn });
  },

  update({ items, query, rect }) {
    set({ items, query, rect });
  },

  setKeyHandler(handler) {
    set({ keyHandler: handler });
  },

  close() {
    set({
      isOpen: false,
      items: [],
      query: "",
      rect: null,
      commandFn: null,
      keyHandler: null,
    });
  },
}));
