import type { ImportAdapter, ImportAdapterParseInput } from "../adapterTypes";
import type { ImportDiagnostic } from "../../core/importDiagnostics";
import { importDiagnostic } from "../../core/importDiagnostics";
import { validateImportSourcePackageDraft } from "../adapterValidation";
import { extensionOfPath } from "../../decoders/decoderProbe";
import { getImportDecoder, listImportDecoders } from "../../decoders/registry";
import "../../decoders/registerDefaults";
import { detectEncoding } from "../../repair/encodingDetector";
import type { DecodedImportResource } from "../../decoders/decoderTypes";
import { buildOneFileOneScenePlan } from "./assemblyPlan";
import { classifyResources } from "./roleClassifier";
import {
  buildImportSourcePackageFromGeneric,
  GENERIC_ADAPTER_ID,
  GENERIC_ADAPTER_VERSION,
} from "./sourcePackageBuilder";
import {
  singleSegmentPartition,
  validateBoundaries,
} from "./documentPartition";

const DESCRIPTOR = {
  id: GENERIC_ADAPTER_ID,
  version: GENERIC_ADAPTER_VERSION,
  label: "Generic",
  inputKinds: ["file", "zip", "plain-text", "unknown"] as const,
  capabilities: {
    supportsStructure: true,
    supportsCodex: true,
    supportsSnippets: true,
    supportsReimport: false,
  },
} as const;

export interface GenericImportFileInput {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface GenericImportParseData {
  readonly title?: string;
  readonly files?: readonly GenericImportFileInput[];
  readonly text?: string;
}

function isGenericImportParseData(
  value: unknown,
): value is GenericImportParseData {
  return !!value && typeof value === "object";
}

function pickDecoder(relativePath: string, bytes: Uint8Array) {
  const extension = extensionOfPath(relativePath);
  const decoders = listImportDecoders();
  for (const descriptor of decoders) {
    if (extension && descriptor.extensions.includes(extension)) {
      return getImportDecoder(descriptor.id, descriptor.version);
    }
  }
  for (const descriptor of decoders) {
    if (
      descriptor.magicPrefixes?.some((prefix) => {
        const encoded = new TextEncoder().encode(prefix);
        if (bytes.length < encoded.length) return false;
        for (let index = 0; index < encoded.length; index += 1) {
          if (bytes[index] !== encoded[index]) return false;
        }
        return true;
      })
    ) {
      return getImportDecoder(descriptor.id, descriptor.version);
    }
  }
  return getImportDecoder("text", "1");
}

function decodeResource(file: GenericImportFileInput): {
  resource: DecodedImportResource | null;
  diagnostics: readonly ImportDiagnostic[];
} {
  const resourceKey = file.relativePath.replace(/[\\/]+/gu, "/");
  const encodingResult = detectEncoding(file.bytes);
  const diagnostics: ImportDiagnostic[] = [];

  if (encodingResult.ambiguous && !encodingResult.decision) {
    diagnostics.push(
      importDiagnostic(
        "warn",
        "encoding-ambiguous",
        "Encoding could not be determined automatically",
        file.relativePath,
      ),
    );
  }

  const decoder = pickDecoder(file.relativePath, file.bytes);
  if (!decoder) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "no-decoder",
        "No decoder registered for resource",
        file.relativePath,
      ),
    );
    return { resource: null, diagnostics };
  }

  const decoded = decoder.decode({
    resourceKey,
    relativePath: file.relativePath,
    bytes: file.bytes,
    encoding: encodingResult.decision?.encoding,
  });

  return {
    resource: decoded,
    diagnostics: [...diagnostics, ...decoded.diagnostics],
  };
}

function normalizeFiles(
  input: ImportAdapterParseInput,
  data: GenericImportParseData,
): readonly GenericImportFileInput[] {
  if (data.files && data.files.length > 0) return data.files;
  if (typeof data.text === "string") {
    return [
      {
        relativePath: input.label || "import.txt",
        bytes: new TextEncoder().encode(data.text),
      },
    ];
  }
  return [];
}

export const genericImportAdapter: ImportAdapter = {
  descriptor: DESCRIPTOR,
  parse(input: ImportAdapterParseInput) {
    if (!isGenericImportParseData(input.data)) {
      return {
        ok: false,
        diagnostics: [
          importDiagnostic(
            "error",
            "unsupported-input",
            "Expected generic import file bundle",
          ),
        ],
      };
    }

    const files = normalizeFiles(input, input.data);
    if (files.length === 0) {
      return {
        ok: false,
        diagnostics: [
          importDiagnostic("error", "empty-input", "No import files provided"),
        ],
      };
    }

    const decodedResources: DecodedImportResource[] = [];
    const diagnostics: ImportDiagnostic[] = [];

    for (const file of files) {
      const result = decodeResource(file);
      diagnostics.push(...result.diagnostics);
      if (result.resource) decodedResources.push(result.resource);
    }

    const partitionDiagnostics: ImportDiagnostic[] = [];
    for (const resource of decodedResources) {
      const blockIds = resource.blocks.map((block) => block.blockId);
      const partition = singleSegmentPartition(
        resource.resourceKey,
        resource.relativePath,
        resource.relativePath.split(/[\\/]/u).pop() ?? resource.resourceKey,
        blockIds,
      );
      const validation = validateBoundaries(partition, blockIds);
      partitionDiagnostics.push(...validation.diagnostics);
    }
    diagnostics.push(...partitionDiagnostics);

    const resolutions = classifyResources(decodedResources);
    const blockIdsByResource = Object.fromEntries(
      decodedResources.map((resource) => [
        resource.resourceKey,
        resource.blocks.map((block) => block.blockId),
      ]),
    );
    const assemblyPlan = buildOneFileOneScenePlan({
      resolutions,
      blockIdsByResource,
    });

    const draft = buildImportSourcePackageFromGeneric({
      label: input.data.title?.trim() || input.label || "Imported",
      decodedResources,
      resolutions,
      assemblyPlan,
    });

    const validationDiagnostics = validateImportSourcePackageDraft(draft);
    const allDiagnostics = [
      ...diagnostics,
      ...draft.diagnostics,
      ...validationDiagnostics,
    ];

    return {
      ok: allDiagnostics.every((d) => d.severity !== "error"),
      draft: { ...draft, diagnostics: allDiagnostics },
      diagnostics: allDiagnostics,
    };
  },
};

export function discoverGenericImportFiles(
  files: readonly GenericImportFileInput[],
): readonly GenericImportFileInput[] {
  return files.filter((file) => file.bytes.length > 0);
}
