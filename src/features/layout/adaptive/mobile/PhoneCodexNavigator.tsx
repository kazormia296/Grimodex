import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface PhoneCodexEntry {
  id: string;
  name: string;
  type: string;
  summary?: string;
}

export interface PhoneCodexEntryType {
  value: string;
  label: string;
}

export interface PhoneCodexEntryEdits {
  type: string;
  summary: string;
}

interface Props {
  entries: readonly PhoneCodexEntry[];
  entryTypes?: readonly PhoneCodexEntryType[];
  selectedEntryId?: string | null;
  onSelectEntry?: (entryId: string) => void;
  onClearSelection?: () => void;
  onSaveEntry?: (
    entryId: string,
    edits: PhoneCodexEntryEdits,
  ) => Promise<boolean | void> | boolean | void;
  readOnly?: boolean;
}

export function PhoneCodexNavigator({
  entries,
  entryTypes = [],
  selectedEntryId,
  onSelectEntry,
  onClearSelection,
  onSaveEntry,
  readOnly = false,
}: Props) {
  const { t } = useTranslation();
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const [typeDraft, setTypeDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const isControlled = selectedEntryId !== undefined;
  const selectedId = isControlled ? selectedEntryId : localSelectedId;
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectedIdRef = useRef(selectedId);
  const saveGenerationRef = useRef(0);
  const savingRef = useRef(false);
  if (selectedIdRef.current !== selectedId) {
    selectedIdRef.current = selectedId;
    saveGenerationRef.current += 1;
    savingRef.current = false;
  }

  useEffect(() => {
    const current = selectedRef.current;
    setTypeDraft(current?.type ?? "");
    setSummaryDraft(current?.summary ?? "");
    setSaving(false);
    setSaveError(false);
  }, [selectedId]);

  const saveEdits = async (): Promise<void> => {
    if (!selected || !onSaveEntry || readOnly || savingRef.current) return;
    const entryId = selected.id;
    const edits = {
      type: typeDraft,
      summary: summaryDraft.trim(),
    };
    const requestGeneration = saveGenerationRef.current + 1;
    saveGenerationRef.current = requestGeneration;
    savingRef.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      const saved = await onSaveEntry(entryId, edits);
      if (
        saveGenerationRef.current !== requestGeneration ||
        selectedIdRef.current !== entryId
      ) {
        return;
      }
      if (saved === false) {
        setSaveError(true);
        return;
      }
      setTypeDraft(edits.type);
      setSummaryDraft(edits.summary);
    } catch {
      if (
        saveGenerationRef.current === requestGeneration &&
        selectedIdRef.current === entryId
      ) {
        setSaveError(true);
      }
    } finally {
      if (
        saveGenerationRef.current === requestGeneration &&
        selectedIdRef.current === entryId
      ) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const typeOptions =
    selected &&
    !entryTypes.some((entryType) => entryType.value === selected.type)
      ? [{ value: selected.type, label: selected.type }, ...entryTypes]
      : entryTypes;

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
          <form
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdits();
            }}
          >
            <label className="grid gap-1 text-sm font-medium">
              {t("mobileWorkspace.surfaces.codex.type")}
              <select
                aria-label={t("mobileWorkspace.surfaces.codex.type")}
                value={typeDraft}
                onChange={(event) => setTypeDraft(event.target.value)}
                disabled={saving || readOnly}
                className="min-h-11 rounded border bg-background px-3"
              >
                {typeOptions.map((entryType) => (
                  <option key={entryType.value} value={entryType.value}>
                    {entryType.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {t("mobileWorkspace.surfaces.codex.summary")}
              <textarea
                aria-label={t("mobileWorkspace.surfaces.codex.summary")}
                value={summaryDraft}
                onChange={(event) => setSummaryDraft(event.target.value)}
                disabled={saving || readOnly}
                rows={6}
                className="min-h-32 resize-y rounded border bg-background p-3 font-normal"
              />
            </label>
            {saveError && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {t("mobileWorkspace.surfaces.codex.saveFailed")}
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                className="min-h-11 rounded bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50"
                disabled={saving || readOnly || !onSaveEntry || !typeDraft}
              >
                {saving
                  ? t("mobileWorkspace.surfaces.codex.saving")
                  : t("mobileWorkspace.surfaces.codex.save")}
              </button>
            </div>
          </form>
        </article>
      )}
    </section>
  );
}
