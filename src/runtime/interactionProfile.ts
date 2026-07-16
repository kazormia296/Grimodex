export type PointerProfile = "fine" | "coarse" | "unknown";
export type HoverProfile = "hover" | "none" | "unknown";

export interface InteractionProfile {
  pointer: PointerProfile;
  hover: HoverProfile;
  reducedMotion: boolean;
}

export function resolveInteractionProfile(
  profile: InteractionProfile,
): InteractionProfile {
  return { ...profile };
}
