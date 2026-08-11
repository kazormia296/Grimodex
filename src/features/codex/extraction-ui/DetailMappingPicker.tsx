import { useState } from "react";

export interface DetailMappingCandidate {
  readonly definitionRef: string;
  readonly label: string;
}

export interface DetailMappingPickerProps {
  readonly facetKey: string;
  readonly candidates: readonly DetailMappingCandidate[];
  readonly selectedDefinitionRef?: string | null;
  readonly onBind?: (
    definitionRef: string,
    options: { readonly rememberBinding: boolean },
  ) => void;
}

/**
 * Mapping picker for unbound Detail facets, with optional "remember binding".
 */
export function DetailMappingPicker({
  facetKey,
  candidates,
  selectedDefinitionRef = null,
  onBind,
}: DetailMappingPickerProps) {
  const [selected, setSelected] = useState(selectedDefinitionRef ?? "");
  const [remember, setRemember] = useState(true);

  return (
    <div
      className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-2"
      data-testid="detail-mapping-picker"
    >
      <p className="text-xs text-foreground">
        未割当ファセット: <span className="font-medium">{facetKey}</span>
      </p>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Detail 定義</span>
        <select
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          data-testid="detail-mapping-select"
        >
          <option value="">選択してください</option>
          {candidates.map((candidate) => (
            <option
              key={candidate.definitionRef}
              value={candidate.definitionRef}
            >
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          data-testid="detail-mapping-remember"
        />
        この割当を記憶する
      </label>
      <button
        type="button"
        className="self-start rounded px-2 py-1 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
        disabled={!selected}
        onClick={() => onBind?.(selected, { rememberBinding: remember })}
        data-testid="detail-mapping-apply"
      >
        割当を確定
      </button>
    </div>
  );
}
