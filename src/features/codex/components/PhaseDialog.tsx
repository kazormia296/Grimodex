import { useState } from "react";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { SceneSelector } from "./SceneSelector";

interface PhaseDialogProps {
  entryId: string;
  phase?: CodexEntryPhase | null;
  onClose: () => void;
}

export function PhaseDialog({ entryId, phase, onClose }: PhaseDialogProps) {
  const createPhase = usePhaseStore((s) => s.createPhase);
  const updatePhase = usePhaseStore((s) => s.updatePhase);

  const [label, setLabel] = useState(phase?.label ?? "");
  const [anchorNodeId, setAnchorNodeId] = useState<string | null>(
    phase?.anchorNodeId ?? null,
  );
  const [summaryOverride, setSummaryOverride] = useState(
    phase?.summaryOverride ?? "",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEditing = phase != null;

  const handleSubmit = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    setIsSubmitting(true);
    try {
      if (isEditing) {
        await updatePhase(phase.id, {
          label: trimmedLabel,
          anchorNodeId,
          summaryOverride: summaryOverride.trim() || null,
        });
      } else {
        await createPhase({
          entryId,
          label: trimmedLabel,
          anchorNodeId,
          summaryOverride: summaryOverride.trim() || null,
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-lg border border-border bg-background p-4 shadow-lg">
        <h3 className="mb-4 text-sm font-semibold">
          {isEditing ? "フェーズを編集" : "フェーズを追加"}
        </h3>

        <div className="space-y-3">
          {/* Label */}
          <div>
            <label className="mb-1 block text-xs font-medium">
              ラベル <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              placeholder="例: 変身後、第二章以降..."
              autoFocus
            />
          </div>

          {/* Anchor scene */}
          <div>
            <label className="mb-1 block text-xs font-medium">
              アンカーシーン
            </label>
            <SceneSelector value={anchorNodeId} onChange={setAnchorNodeId} />
          </div>

          {/* Summary override */}
          <div>
            <label className="mb-1 block text-xs font-medium">
              概要の上書き
              <span className="ml-1 text-[10px] text-muted-foreground">
                (任意)
              </span>
            </label>
            <textarea
              value={summaryOverride}
              onChange={(e) => setSummaryOverride(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              placeholder="このフェーズ以降の概要..."
            />
          </div>
        </div>

        {/* Buttons */}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!label.trim() || isSubmitting}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isSubmitting ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
