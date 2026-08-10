import { sha256Hex } from "@grimodex/scan-contract";
import type { ImportSourcePackageDraft } from "../../core/importSourcePackage";
import { IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION } from "../../core/importSourcePackage";
import { EMPTY_PROSEMIRROR_DOC } from "../../core/importSourceDocument";
import type { DecodedImportResource } from "../../decoders/decoderTypes";
import type { GenericImportAssemblyPlan } from "./assemblyPlan";
import type { ResourceRoleResolution } from "./roleClassifier";

const GENERIC_ADAPTER_ID = "generic";
const GENERIC_ADAPTER_VERSION = "1";

export interface BuildSourcePackageInput {
  readonly label: string;
  readonly decodedResources: readonly DecodedImportResource[];
  readonly resolutions: readonly ResourceRoleResolution[];
  readonly assemblyPlan: GenericImportAssemblyPlan;
  readonly createdAt?: string;
}

function blocksPlainText(resource: DecodedImportResource, blockIds: readonly string[]): string {
  const idSet = new Set(blockIds);
  return resource.blocks
    .filter((block) => idSet.size === 0 || idSet.has(block.blockId))
    .map((block) => block.text)
    .join("\n\n");
}

function buildStructureRecords(
  resources: readonly DecodedImportResource[],
  plan: GenericImportAssemblyPlan,
): ImportSourcePackageDraft["structure"] {
  const byKey = new Map(resources.map((resource) => [resource.resourceKey, resource]));
  const codexEntries: ImportSourcePackageDraft["structure"]["codexEntries"][number][] = [];
  const snippets: ImportSourcePackageDraft["structure"]["snippets"][number][] = [];

  for (const record of plan.structureRecords) {
    const resource = byKey.get(record.resourceKey);
    if (!resource?.structuredData || typeof resource.structuredData !== "object") continue;
    const data = resource.structuredData as {
      headers?: string[];
      rows?: string[][];
    };
    const headers = data.headers ?? [];
    const rows = data.rows ?? [];

    if (
      record.role === "character-reference" ||
      record.role === "world-reference" ||
      record.role === "glossary"
    ) {
      const nameIndex = headers.findIndex((h) => h.toLocaleLowerCase("en-US") === "name");
      const typeIndex = headers.findIndex((h) => h.toLocaleLowerCase("en-US") === "type");
      rows.forEach((row, index) => {
        codexEntries.push({
          id: `codex:${record.resourceKey}:${index}`,
          kind: "codex-entry",
          origin: "source-native",
          name: row[nameIndex >= 0 ? nameIndex : 0] ?? `Entry ${index + 1}`,
          entryType: row[typeIndex >= 0 ? typeIndex : 1] ?? "unknown",
          aliases: [],
          sourceKey: record.resourceKey,
        });
      });
    }

    if (record.role === "snippet-library") {
      const titleIndex = headers.findIndex((h) => h.toLocaleLowerCase("en-US") === "title");
      const contentIndex = headers.findIndex((h) => h.toLocaleLowerCase("en-US") === "content");
      rows.forEach((row, index) => {
        snippets.push({
          id: `snippet:${record.resourceKey}:${index}`,
          kind: "snippet",
          origin: "source-native",
          title: row[titleIndex >= 0 ? titleIndex : 0] ?? `Snippet ${index + 1}`,
          content: row[contentIndex >= 0 ? contentIndex : 1] ?? "",
          sourceKey: record.resourceKey,
        });
      });
    }
  }

  return { codexEntries, snippets };
}

export function buildImportSourcePackageFromGeneric(
  input: BuildSourcePackageInput,
): ImportSourcePackageDraft {
  const now = input.createdAt ?? new Date().toISOString();
  const byKey = new Map(
    input.decodedResources.map((resource) => [resource.resourceKey, resource]),
  );

  const nodes: ImportSourcePackageDraft["nodes"][number][] = [];
  const documents: ImportSourcePackageDraft["documents"][number][] = [];

  input.assemblyPlan.scenes.forEach((scene, orderIndex) => {
    const resource = byKey.get(scene.resourceKey);
    const plainText = resource
      ? blocksPlainText(resource, scene.blockIds)
      : "";
    nodes.push({
      key: scene.sceneKey,
      parentKey: null,
      title: scene.title,
      orderIndex,
      kind: "scene",
    });
    documents.push({
      key: `doc:${scene.sceneKey}`,
      nodeKey: scene.sceneKey,
      title: scene.title,
      orderIndex,
      proseMirrorJson: EMPTY_PROSEMIRROR_DOC,
      plainText,
    });
  });

  const fingerprintPayload = {
    label: input.label,
    scenes: input.assemblyPlan.scenes.map((scene) => scene.resourceKey),
    structure: input.assemblyPlan.structureRecords.map((record) => record.resourceKey),
  };
  const fingerprint = sha256Hex(JSON.stringify(fingerprintPayload));

  const diagnostics = input.decodedResources.flatMap((resource) => resource.diagnostics);

  return {
    schemaVersion: IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION,
    identity: {
      sourceSetId: `generic:${fingerprint}`,
      fingerprint,
      hints: {
        adapterId: GENERIC_ADAPTER_ID,
        adapterVersion: GENERIC_ADAPTER_VERSION,
        originalFormat: "generic",
        titleHint: input.label,
      },
    },
    manifest: {
      entries: input.decodedResources.map((resource) => ({
        kind: "file" as const,
        label: resource.relativePath,
      })),
    },
    nodes,
    documents,
    structure: buildStructureRecords(input.decodedResources, input.assemblyPlan),
    diagnostics,
    createdAt: now,
  };
}

export { GENERIC_ADAPTER_ID, GENERIC_ADAPTER_VERSION };
