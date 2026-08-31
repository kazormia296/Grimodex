import type { WorkLayerDisposition, WorkLayerModel } from "./types";

export function disposeWorkLayerFinding(
  model: WorkLayerModel,
  findingId: string,
  disposition: WorkLayerDisposition,
): WorkLayerModel {
  const finding = model.attention.find((item) => item.id === findingId);
  if (finding == null) return model;

  return {
    ...model,
    attention: model.attention.filter((item) => item.id !== findingId),
    disposedAttention: [
      ...model.disposedAttention.filter((item) => item.id !== findingId),
      { id: finding.id, title: finding.title, disposition },
    ],
  };
}
