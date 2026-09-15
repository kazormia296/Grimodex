import type { Dispatch, SetStateAction } from "react";
import type { CodexEntry } from "./api";
import type { CodexRelationRow } from "./codexRelationApi";

export interface CodexEntityRelationReviewSelectorsProps {
  readonly entries: readonly CodexEntry[];
  readonly scenes: readonly { id: string; title: string }[];
  readonly relations: readonly CodexRelationRow[];
  readonly sceneId: string;
  readonly setSceneId: Dispatch<SetStateAction<string>>;
  readonly selectedEntityIds: ReadonlySet<string>;
  readonly setSelectedEntityIds: Dispatch<SetStateAction<Set<string>>>;
  readonly selectedRelationIds: ReadonlySet<string>;
  readonly setSelectedRelationIds: Dispatch<SetStateAction<Set<string>>>;
  readonly selectionError: string | null;
}

function toggleSelection(
  setter: Dispatch<SetStateAction<Set<string>>>,
  id: string,
) {
  setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

function relationLabel(
  relation: CodexRelationRow,
  entries: readonly CodexEntry[],
): string {
  const from =
    entries.find((entry) => entry.id === relation.fromCodexId)?.name ??
    relation.fromCodexId;
  const to =
    entries.find((entry) => entry.id === relation.toCodexId)?.name ??
    relation.toCodexId;
  return `${from} — ${relation.label?.trim() || relation.relationType} → ${to}`;
}

export function CodexEntityRelationReviewSelectors({
  entries,
  scenes,
  relations,
  sceneId,
  setSceneId,
  selectedEntityIds,
  setSelectedEntityIds,
  selectedRelationIds,
  setSelectedRelationIds,
  selectionError,
}: CodexEntityRelationReviewSelectorsProps) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Scene Scope</span>
        <span className="text-muted-foreground">
          本文Evidenceではありません。Nativeが現在のScopeを検証します。
        </span>
        <select
          value={sceneId}
          onChange={(event) => setSceneId(event.target.value)}
          className="rounded border border-input bg-background px-2 py-1.5 text-sm"
          data-testid="nir1-typed-scene-scope"
        >
          <option value="">Sceneを選択</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.title}
            </option>
          ))}
        </select>
      </label>

      <fieldset
        className="space-y-1 rounded border border-border/70 p-2"
        data-testid="nir1-typed-entity-selector"
      >
        <legend className="px-1 text-xs font-medium">Entity</legend>
        {entries.map((candidate) => (
          <label
            key={candidate.id}
            className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted/40"
          >
            <input
              type="checkbox"
              checked={selectedEntityIds.has(candidate.id)}
              onChange={() =>
                toggleSelection(setSelectedEntityIds, candidate.id)
              }
              data-testid={`nir1-typed-entity-${candidate.id}`}
            />
            <span>{candidate.name}</span>
            <span className="text-muted-foreground">({candidate.type})</span>
          </label>
        ))}
      </fieldset>

      <fieldset
        className="space-y-1 rounded border border-border/70 p-2"
        data-testid="nir1-typed-relation-selector"
      >
        <legend className="px-1 text-xs font-medium">Relation</legend>
        {relations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            選択できるRelationがありません。
          </p>
        ) : (
          relations.map((relation) => (
            <label
              key={relation.id}
              className="flex items-start gap-2 rounded px-1 py-1 text-xs hover:bg-muted/40"
              data-testid={`nir1-typed-relation-option-${relation.id}`}
            >
              <input
                type="checkbox"
                checked={selectedRelationIds.has(relation.id)}
                onChange={() =>
                  toggleSelection(setSelectedRelationIds, relation.id)
                }
                data-testid={`nir1-typed-relation-${relation.id}`}
              />
              <span>
                {relationLabel(relation, entries)}
                <span
                  className="ml-1 text-[10px] text-muted-foreground"
                  data-testid={`nir1-typed-relation-endpoints-${relation.id}`}
                >
                  Relation選択時の端点EntityはNativeが自動包含
                </span>
              </span>
            </label>
          ))
        )}
      </fieldset>

      {selectionError && (
        <p className="text-xs text-destructive" role="alert">
          {selectionError}
        </p>
      )}
    </div>
  );
}
