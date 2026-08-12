import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getImportAdapter } from "../../adapters/registry";
import { genericImportAdapter } from "../../adapters/generic/genericImportAdapter";
import type { ImportSourcePackageDraft } from "../../core/importSourcePackage";
import type { ImportDiagnostic } from "../../core/importDiagnostics";
import { classifyResources } from "../../adapters/generic/roleClassifier";
import { buildOneFileOneScenePlan } from "../../adapters/generic/assemblyPlan";
import { GenericResourceTree } from "./GenericResourceTree";
import { GenericRolePicker } from "./GenericRolePicker";
import { GenericImportSummary } from "./GenericImportSummary";
import { GenericDecoderPicker } from "./GenericDecoderPicker";
import type { GenericImportResourceRole } from "../../adapters/generic/resourceRole";
import { dispositionForRole } from "../../adapters/generic/roleClassifier";
import type { DecodedImportResource } from "../../decoders/decoderTypes";

interface Props {
  readonly onClose: () => void;
}

export function GenericImportWizardPreview({ onClose }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ImportSourcePackageDraft | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly ImportDiagnostic[]>(
    [],
  );
  const [selectedResourceKey, setSelectedResourceKey] = useState<string | null>(
    null,
  );
  const [roleOverrides, setRoleOverrides] = useState<
    Readonly<Record<string, GenericImportResourceRole>>
  >({});
  const [selectedDecoderId, setSelectedDecoderId] = useState<string | null>(
    "text",
  );

  const runPreview = useCallback(async () => {
    const adapter = getImportAdapter("generic", "1") ?? genericImportAdapter;
    const sampleText = "# Chapter One\n\nPreview paragraph for generic import.";
    const result = await Promise.resolve(
      adapter.parse({
        kind: "plain-text",
        label: "generic-preview",
        data: { title: "Generic Preview", text: sampleText },
      }),
    );
    setDraft(result.draft ?? null);
    setDiagnostics(result.diagnostics);
  }, []);

  const manifestEntries = draft?.manifest.entries ?? [];
  const decodedPreviewResources = useMemo(
    () =>
      manifestEntries.map((entry, index) => ({
        resourceKey: entry.label.replace(/[\\/]+/gu, "/"),
        relativePath: entry.label,
        kind: "markdown" as const,
        structuredData: undefined,
        _index: index,
      })),
    [manifestEntries],
  );

  const resolutions = useMemo(() => {
    const decodedResources: DecodedImportResource[] = decodedPreviewResources.map(
      ({ _index: _, ...resource }) => ({
        ...resource,
        decoderId: "markdown",
        decoderVersion: "1",
        blocks: [],
        diagnostics: [],
      }),
    );
    const base = classifyResources(decodedResources);
    return base.map((resolution) => {
      const override = roleOverrides[resolution.resourceKey];
      if (!override) return resolution;
      return {
        ...resolution,
        role: override,
        disposition: dispositionForRole(override),
        confidence: "manual" as const,
      };
    });
  }, [decodedPreviewResources, roleOverrides]);

  const assemblyPlan = useMemo(() => {
    const blockIdsByResource = Object.fromEntries(
      decodedPreviewResources.map((resource) => [
        resource.resourceKey,
        [`${resource.resourceKey}:p0`],
      ]),
    );
    return buildOneFileOneScenePlan({ resolutions, blockIdsByResource });
  }, [decodedPreviewResources, resolutions]);

  const selectedResolution =
    resolutions.find((r) => r.resourceKey === selectedResourceKey) ??
    resolutions[0] ??
    null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="generic-import-wizard"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {t("import.generic.wizardTitle", "Generic インポート（プレビュー）")}
        </h3>
        <button
          type="button"
          data-testid="generic-import-run-preview"
          onClick={() => void runPreview()}
          className="rounded bg-muted px-2 py-1 text-xs hover:bg-accent"
        >
          {t("import.generic.runPreview", "プレビュー実行")}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <GenericDecoderPicker
          selectedDecoderId={selectedDecoderId}
          onSelectDecoder={setSelectedDecoderId}
        />
        <GenericResourceTree
          resources={resolutions}
          selectedResourceKey={selectedResourceKey ?? selectedResolution?.resourceKey ?? null}
          onSelectResource={setSelectedResourceKey}
        />
        {selectedResolution && (
          <GenericRolePicker
            role={selectedResolution.role}
            disposition={selectedResolution.disposition}
            candidates={selectedResolution.candidates}
            onRoleChange={(role) => {
              setRoleOverrides((prev) => ({
                ...prev,
                [selectedResolution.resourceKey]: role,
              }));
            }}
          />
        )}
        <GenericImportSummary draft={draft} assemblyPlan={assemblyPlan} />
        {diagnostics.length > 0 && (
          <ul className="text-xs text-muted-foreground" data-testid="generic-import-diagnostics">
            {diagnostics.map((diag, index) => (
              <li key={`${diag.code}-${index}`}>
                [{diag.severity}] {diag.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 justify-end border-t border-border pt-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          {t("common.cancel", "キャンセル")}
        </button>
      </div>
    </div>
  );
}
