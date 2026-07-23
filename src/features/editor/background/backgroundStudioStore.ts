import { create } from "zustand";

interface BackgroundStudioState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useBackgroundStudioStore = create<BackgroundStudioState>()(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((state) => ({ open: !state.open })),
  }),
);
