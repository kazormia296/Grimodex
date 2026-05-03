import i18next from "@/lib/i18n";
import { PALETTE_SLOTS } from "@/lib/labelPalette";
import { listLabels, createLabel } from "@/features/labels/labelApi";
import { useLabelStore } from "@/features/labels/labelStore";
import { LABEL_TEMPLATES } from "./labelTemplates";

export interface ApplyTemplateResult {
  added: number;
  skipped: number;
}

export async function applyLabelTemplate(
  projectId: string,
  templateKey: string,
): Promise<ApplyTemplateResult> {
  const template = LABEL_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw new Error(`Unknown template key: ${templateKey}`);

  const existing = await listLabels(projectId);
  const existingNames = new Set(existing.map((l) => l.name));
  const maxExistingOrder = Math.max(-1, ...existing.map((l) => l.sortOrder));

  let added = 0;
  let skipped = 0;
  let sortOrder = maxExistingOrder + 1.0;

  for (const item of template.labels) {
    const name = i18next.t(`grid.labelTemplates.labels.${item.nameI18nKey}`, {
      defaultValue: item.nameI18nKey,
    });
    if (existingNames.has(name)) {
      skipped++;
      continue;
    }
    const color = PALETTE_SLOTS[item.paletteSlotIndex % PALETTE_SLOTS.length];
    await createLabel({
      id: crypto.randomUUID(),
      projectId,
      name,
      color,
      sortOrder,
    });
    existingNames.add(name);
    sortOrder += 1.0;
    added++;
  }

  // Reload label store so the UI reflects the new labels
  if (added > 0) {
    await useLabelStore.getState().load(projectId);
  }

  return { added, skipped };
}
