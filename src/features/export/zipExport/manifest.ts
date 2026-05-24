import type { Project } from "@/features/project/api";
import type { ZipExportSettings } from "./types";

export interface Manifest {
  schemaVersion: 1;
  exportedAt: string;
  grimodexVersion: string;
  project: {
    id: string;
    title: string;
    createdAt: string;
  };
  exportSettings: ZipExportSettings;
}

export function buildManifest(
  project: Pick<Project, "id" | "title" | "createdAt">,
  settings: ZipExportSettings,
  grimodexVersion: string,
): Manifest {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    grimodexVersion,
    project: {
      id: project.id,
      title: project.title,
      createdAt: project.createdAt,
    },
    exportSettings: settings,
  };
}
