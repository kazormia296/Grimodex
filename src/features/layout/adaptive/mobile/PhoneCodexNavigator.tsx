import { useState } from "react";

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
  onOpenAnchor?: (sceneId: string) => void;
}

export function PhoneCodexNavigator({ entries, onOpenAnchor }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  return (
    <section
      aria-label="Codex"
      data-phone-codex-navigator
      className="grid min-h-full grid-cols-1"
    >
      {!selected && (
        <ul className="m-0 grid list-none gap-1 p-3">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="min-h-11 w-full rounded border px-3 text-left"
                onClick={() => setSelectedId(entry.id)}
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
            onClick={() => setSelectedId(null)}
          >
            ‹ Codex
          </button>
          <h1 className="mt-3 text-xl font-semibold">{selected.name}</h1>
          <p className="text-sm text-muted-foreground">{selected.type}</p>
          {selected.summary && <p className="mt-3">{selected.summary}</p>}
          <h2 className="mt-6 text-base font-semibold">Phases</h2>
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
                    Open anchor scene
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
