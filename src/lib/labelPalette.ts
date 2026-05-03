export interface PaletteColor {
  light: string;
  dark: string;
  label: string;
}

export const LABEL_PALETTE: Record<string, PaletteColor> = {
  red: { light: "#DC2626", dark: "#EF4444", label: "Red" },
  orange: { light: "#EA580C", dark: "#FB923C", label: "Orange" },
  amber: { light: "#D97706", dark: "#FBBF24", label: "Amber" },
  yellow: { light: "#CA8A04", dark: "#FACC15", label: "Yellow" },
  lime: { light: "#65A30D", dark: "#A3E635", label: "Lime" },
  emerald: { light: "#059669", dark: "#34D399", label: "Emerald" },
  teal: { light: "#0D9488", dark: "#2DD4BF", label: "Teal" },
  sky: { light: "#0284C7", dark: "#38BDF8", label: "Sky" },
  violet: { light: "#7C3AED", dark: "#A78BFA", label: "Violet" },
  fuchsia: { light: "#C026D3", dark: "#E879F9", label: "Fuchsia" },
  rose: { light: "#E11D48", dark: "#FB7185", label: "Rose" },
  slate: { light: "#475569", dark: "#94A3B8", label: "Slate" },
};

export const PALETTE_SLOTS = Object.keys(LABEL_PALETTE);

export function resolveLabelColor(slotName: string, dark = false): string {
  const entry = LABEL_PALETTE[slotName];
  if (!entry) return dark ? "#94A3B8" : "#475569";
  return dark ? entry.dark : entry.light;
}

export function getPaletteSlotAtIndex(index: number): string {
  return PALETTE_SLOTS[index % PALETTE_SLOTS.length];
}
