import type {
  GenericImportResourceRole,
  ImportResourceDisposition,
} from "./resourceRole";
import type { ResourceRoleResolution } from "./roleClassifier";

export interface GenericAssemblyScenePlan {
  readonly sceneKey: string;
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly title: string;
  readonly blockIds: readonly string[];
}

export interface GenericAssemblyStructurePlan {
  readonly recordKey: string;
  readonly resourceKey: string;
  readonly role: GenericImportResourceRole;
  readonly disposition: ImportResourceDisposition;
}

export interface GenericImportAssemblyPlan {
  readonly planId: string;
  readonly scenes: readonly GenericAssemblyScenePlan[];
  readonly structureRecords: readonly GenericAssemblyStructurePlan[];
  readonly skippedResourceKeys: readonly string[];
}

export function buildOneFileOneScenePlan(input: {
  readonly resolutions: readonly ResourceRoleResolution[];
  readonly blockIdsByResource: Readonly<Record<string, readonly string[]>>;
}): GenericImportAssemblyPlan {
  const scenes: GenericAssemblyScenePlan[] = [];
  const structureRecords: GenericAssemblyStructurePlan[] = [];
  const skipped: string[] = [];

  for (const resolution of input.resolutions) {
    if (resolution.disposition === "ignore") {
      skipped.push(resolution.resourceKey);
      continue;
    }

    if (
      resolution.disposition === "import-as-project-document" ||
      resolution.disposition === "import-and-extract"
    ) {
      if (
        resolution.role === "manuscript" ||
        resolution.role === "snippet-library" ||
        resolution.role === "outline" ||
        resolution.role === "chat-log"
      ) {
        const fileName =
          resolution.relativePath.split(/[\\/]/u).pop() ??
          resolution.resourceKey;
        const title = fileName.replace(/\.[^.]+$/u, "") || fileName;
        scenes.push({
          sceneKey: `scene:${resolution.resourceKey}`,
          resourceKey: resolution.resourceKey,
          relativePath: resolution.relativePath,
          title,
          blockIds: input.blockIdsByResource[resolution.resourceKey] ?? [],
        });
      }
    }

    if (resolution.disposition === "extract-structure-only") {
      structureRecords.push({
        recordKey: `structure:${resolution.resourceKey}`,
        resourceKey: resolution.resourceKey,
        role: resolution.role,
        disposition: resolution.disposition,
      });
      continue;
    }

    if (resolution.disposition === "retain-source-only") {
      skipped.push(resolution.resourceKey);
    }
  }

  return {
    planId: `assembly:${scenes.length}:${structureRecords.length}`,
    scenes,
    structureRecords,
    skippedResourceKeys: skipped,
  };
}
