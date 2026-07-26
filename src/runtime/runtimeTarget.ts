export type RuntimeTarget = "electron" | "web" | "mobile-native";

export const runtimeTargets = [
  "electron",
  "web",
  "mobile-native",
] as const satisfies readonly RuntimeTarget[];
