import { create } from "zustand";

export type ReleaseNotesMode = "auto" | "manual";

interface ReleaseNotesState {
  isOpen: boolean;
  version: string | null;
  src: string | null;
  isFallback: boolean;
  mode: ReleaseNotesMode;
  openAuto: (params: {
    version: string;
    src: string;
    isFallback: boolean;
  }) => void;
  openManual: (params: {
    version: string;
    src: string;
    isFallback: boolean;
  }) => void;
  close: () => void;
}

const CLOSED = {
  isOpen: false,
  version: null as string | null,
  src: null as string | null,
  isFallback: false,
  mode: "auto" as ReleaseNotesMode,
};

export const useReleaseNotesStore = create<ReleaseNotesState>()((set) => ({
  ...CLOSED,
  openAuto: ({ version, src, isFallback }) =>
    set({ isOpen: true, version, src, isFallback, mode: "auto" }),
  openManual: ({ version, src, isFallback }) =>
    set({ isOpen: true, version, src, isFallback, mode: "manual" }),
  close: () => set({ ...CLOSED }),
}));

/** テスト用: 初期状態へ戻す。 */
export function _resetReleaseNotesStoreForTests(): void {
  useReleaseNotesStore.setState({ ...CLOSED });
}
