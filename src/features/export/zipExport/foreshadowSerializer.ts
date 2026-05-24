import type {
  ForeshadowRow,
  ForeshadowSetupRow,
} from "@/features/foreshadow/types";
import type { CodexEntry } from "@/features/codex/api";
import type { ScenePathInfo } from "./types";
import { resolveUniqueSlug } from "./slug";

export interface ForeshadowExportInput {
  foreshadow: ForeshadowRow;
  setups: ForeshadowSetupRow[];
  linkedCodexNames: string[];
  scenePathById: Map<string, ScenePathInfo>;
}

function formatSceneRef(
  sceneId: string,
  fromPos: number,
  toPos: number,
  scenePathById: Map<string, ScenePathInfo>,
  extra?: string,
): string | null {
  const info = scenePathById.get(sceneId);
  if (!info) return null;
  const range = `(range ${fromPos}-${toPos}${extra ? `, ${extra}` : ""})`;
  return `- ${info.relativePath}  ${range}`;
}

export function serializeForeshadow(input: ForeshadowExportInput): string {
  const { foreshadow: f, setups, linkedCodexNames, scenePathById } = input;

  const frontmatter = [
    "---",
    `id: ${f.id}`,
    `title: ${JSON.stringify(f.title)}`,
    `intent: ${JSON.stringify(f.intent ?? "")}`,
    `secret: ${f.secret}`,
    `load_bearing: ${f.loadBearing ? JSON.stringify(f.loadBearing) : "null"}`,
    `payoff_confirmed: ${f.payoffConfirmed}`,
    `abandoned: ${f.abandoned}`,
    `linked_codex: ${JSON.stringify(linkedCodexNames)}`,
    "---",
    "",
  ].join("\n");

  const notes = f.notes?.trim() ? `## Notes\n\n${f.notes.trim()}\n\n` : "";

  const setupLines = setups
    .map((s) => {
      const extra = [
        `kind=${s.kind}`,
        s.strength ? `strength=${s.strength}` : null,
        `attribution=${s.attribution}`,
      ]
        .filter(Boolean)
        .join(", ");
      return formatSceneRef(
        s.sceneId,
        s.fromPos,
        s.toPos,
        scenePathById,
        extra,
      );
    })
    .filter((line): line is string => line !== null);

  const setupsSection =
    setupLines.length > 0
      ? `## Setups\n\n${setupLines.join("\n")}\n\n`
      : "## Setups\n\n";

  let payoffSection = "## Payoff\n\n";
  if (f.payoffSceneId && f.payoffFromPos != null && f.payoffToPos != null) {
    const line = formatSceneRef(
      f.payoffSceneId,
      f.payoffFromPos,
      f.payoffToPos,
      scenePathById,
    );
    payoffSection += line ? `${line}\n` : "";
  }

  return frontmatter + notes + setupsSection + payoffSection;
}

export function serializeForeshadows(
  foreshadows: ForeshadowRow[],
  setupsByForeshadow: Map<string, ForeshadowSetupRow[]>,
  codexLinks: Map<string, string[]>,
  scenePathById: Map<string, ScenePathInfo>,
): { path: string; content: string }[] {
  const used = new Set<string>();
  return foreshadows.map((f) => {
    const slug = resolveUniqueSlug(f.title, used);
    return {
      path: `codex/foreshadows/${slug}.md`,
      content: serializeForeshadow({
        foreshadow: f,
        setups: setupsByForeshadow.get(f.id) ?? [],
        linkedCodexNames: codexLinks.get(f.id) ?? [],
        scenePathById,
      }),
    };
  });
}

export function buildCodexNameMap(entries: CodexEntry[]): Map<string, string> {
  return new Map(entries.map((e) => [e.id, e.name]));
}
