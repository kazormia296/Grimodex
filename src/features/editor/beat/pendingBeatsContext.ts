import type { UnplacedBeat } from "./unplacedBeatsStore";
import { listPlacedBeatsFromJson } from "./listPlacedBeats";

const MAX_INSTRUCTIONS_LENGTH = 200;

export interface BuildPendingBeatsInput {
  /** scene.content as parsed PM-JSON. null/undefined → no placed beats. */
  sceneDocJson: unknown | null;
  /** unplacedBeatsStore.getBeats(sceneId) result. */
  unplacedBeats: UnplacedBeat[];
  /** Resolves a Codex character id to its display name. Returns null if unknown. */
  resolveCharacterName: (codexId: string) => string | null;
  /**
   * The beat currently being generated. beats after this one (in doc order)
   * plus all unplaced beats are included.
   * null → include ALL placed beats + all unplaced (for Chat context).
   */
  currentBeatId: string | null;
  /** Scene-level POV character id. When a beat's pov matches this, the label is omitted. */
  scenePovCharacterId?: string | null;
}

function truncate(text: string): string {
  if (text.length <= MAX_INSTRUCTIONS_LENGTH) return text;
  return text.slice(0, MAX_INSTRUCTIONS_LENGTH) + "…";
}

function extractUnplacedText(content: UnplacedBeat["content"]): string {
  return (content ?? [])
    .map((n) => (n.type === "text" ? (n.text ?? "") : ""))
    .join("");
}

/**
 * Build a markdown section listing "pending beats" for this scene to inject
 * into the AI prompt. Returns "" when there is nothing to show.
 *
 * Beat生成側: currentBeatId より後ろの Placed beat + 全 Unplaced beat
 * Chat側:    全 Placed beat + 全 Unplaced beat (currentBeatId === null)
 */
export function buildPendingBeatsSection(
  input: BuildPendingBeatsInput,
): string {
  const {
    sceneDocJson,
    unplacedBeats,
    resolveCharacterName,
    currentBeatId,
    scenePovCharacterId,
  } = input;

  const allPlaced = listPlacedBeatsFromJson(sceneDocJson);

  let pendingPlaced = allPlaced;
  if (currentBeatId !== null) {
    const currentIndex = allPlaced.findIndex((b) => b.beatId === currentBeatId);
    if (currentIndex >= 0) {
      pendingPlaced = allPlaced.slice(currentIndex + 1);
    } else {
      // currentBeatId not found (shouldn't happen in normal flow) → include all
      pendingPlaced = allPlaced;
    }
  }

  const lines: string[] = [];

  for (const beat of pendingPlaced) {
    const parts: string[] = [`Placed #${beat.index}`, beat.beatType];
    if (beat.povCharacterId && beat.povCharacterId !== scenePovCharacterId) {
      const name = resolveCharacterName(beat.povCharacterId);
      if (name) parts.push(`POV: ${name}`);
    }
    const label = `[${parts.join(" / ")}]`;
    const text = truncate(beat.instructions.trim());
    lines.push(`- ${label} ${text}`);
  }

  for (const beat of unplacedBeats) {
    const parts: string[] = ["Unplaced", beat.beatType];
    if (beat.pov && beat.pov !== scenePovCharacterId) {
      const name = resolveCharacterName(beat.pov);
      if (name) parts.push(`POV: ${name}`);
    }
    const label = `[${parts.join(" / ")}]`;
    const text = truncate(extractUnplacedText(beat.content).trim());
    lines.push(`- ${label} ${text}（順不同）`);
  }

  if (lines.length === 0) return "";

  return `\n## このシーンの予定ビート\n${lines.join("\n")}\n`;
}
