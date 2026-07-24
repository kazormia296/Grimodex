import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface PhoneCodexPhase {
  id: string;
  label: string;
  summary?: string;
  anchorSceneId?: string;
}

export interface PhoneCodexEntry {
  id: string;
  name: string;
  type: string;
  summary?: string;
  phases?: readonly PhoneCodexPhase[];
}

interface Props {
  entries: readonly PhoneCodexEntry[];
  selectedEntryId?: string | null;
  onOpenAnchor?: (sceneId: string) => void;
  onSelectEntry?: (entryId: string) => void;
  onClearSelection?: () => void;
}

export function PhoneCodexNavigator({
  entries,
  selectedEntryId,
  onOpenAnchor,
  onSelectEntry,
  onClearSelection,
}: Props) {
  const { t } = useTranslation();
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const isControlled = selectedEntryId !== undefined;
  const selectedId = isControlled ? selectedEntryId : localSelectedId;
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  return (
    <section
      aria-label="Codex"
      data-phone-codex-navigator
      className="grid min-h-full grid-cols-1"
    >
      {!selected && entries.length === 0 && (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {t("mobileWorkspace.surfaces.codex.empty")}
        </p>
      )}
      {!selected && (
        <ul className="m-0 grid list-none gap-1 p-3">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="min-h-11 w-full rounded border px-3 text-left"
                onClick={() => {
                  if (!isControlled) setLocalSelectedId(entry.id);
                  onSelectEntry?.(entry.id);
                }}
              >
                <span className="block font-medium">{entry.name}</span>
                <small className="text-muted-foreground">{entry.type}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <article className="p-4">
          <button
            type="button"
            className="min-h-11 rounded px-2"
            onClick={() => {
              if (!isControlled) setLocalSelectedId(null);
              onClearSelection?.();
            }}
          >
            ‹ {t("mobileWorkspace.surfaces.codex.back")}
          </button>
          <h1 className="mt-3 text-xl font-semibold">{selected.name}</h1>
          <p className="text-sm text-muted-foreground">{selected.type}</p>
          {selected.summary && <p className="mt-3">{selected.summary}</p>}
          <h2 className="mt-6 text-base font-semibold">
            {t("mobileWorkspace.surfaces.codex.phases")}
          </h2>
          <ul className="m-0 grid list-none gap-2 p-0">
            {(selected.phases ?? []).map((phase) => (
              <li key={phase.id} className="rounded border p-3">
                <strong>{phase.label}</strong>
                {phase.summary && (
                  <p className="mt-1 text-sm">{phase.summary}</p>
                )}
                {phase.anchorSceneId && (
                  <button
                    type="button"
                    className="mt-2 min-h-11 rounded border px-3 text-sm"
                    onClick={() => onOpenAnchor?.(phase.anchorSceneId!)}
                  >
                    {t("mobileWorkspace.surfaces.codex.openAnchor")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
