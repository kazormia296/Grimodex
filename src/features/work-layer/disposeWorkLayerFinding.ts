import type { WorkLayerDisposition, WorkLayerModel } from "./types";
import {
  createDisposedWorkLedgerItem,
  disposedFindingLedgerItemId,
} from "./workLedgerItems";

export function disposeWorkLayerFinding(
  model: WorkLayerModel,
  findingId: string,
  disposition: WorkLayerDisposition,
): WorkLayerModel {
  const finding = model.attention.find((item) => item.id === findingId);
  if (finding == null) return model;

  const disposedFinding = {
    id: finding.id,
    title: finding.title,
    disposition,
  };
  const disposedLedgerItem = createDisposedWorkLedgerItem(disposedFinding);
  const allWork =
    model.allWork == null
      ? undefined
      : model.allWork.some(
            (item) =>
              item.id === disposedFindingLedgerItemId(disposedFinding.id),
          )
        ? model.allWork.map((item) =>
            item.id === disposedLedgerItem.id
              ? { ...item, ...disposedLedgerItem }
              : item,
          )
        : [...model.allWork, disposedLedgerItem];

  return {
    ...model,
    attention: model.attention.filter((item) => item.id !== findingId),
    disposedAttention: [
      ...model.disposedAttention.filter((item) => item.id !== findingId),
      disposedFinding,
    ],
    ...(allWork == null ? {} : { allWork }),
  };
}
